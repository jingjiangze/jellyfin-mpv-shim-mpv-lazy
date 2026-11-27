/* ---------------- 个人主页（user.html）：资料卡 + 我的追番 ----------------
   资料来自 GET /auth/profile（Bearer）。后端还没上 profile 时回 404，
   这里退回顶栏用的 /auth/me（字段少一些，头像 / 昵称够渲染）。
   统计与「我的追番」全走本地（favList / 分集进度），不发额外请求。
   USER 缓存上次回来的资料：换清晰度触发的 repaint 复用它，不重复打接口。 */
  var USER = null;
  var userWatch = 0;

  /* 邮箱掩码：a***@domain。不带 @ 的（没填邮箱，或后端只给了昵称）原样返回。 */
  function maskEmail(s) {
    var v = String(s || '');
    var at = v.indexOf('@');
    if (at <= 0) return v;
    return v.charAt(0) + '***' + v.slice(at);
  }

  /* 昵称：u.name 里含 @ 说明后端塞的还是邮箱（用户没设昵称），改用 login。
     name 与 login 都没有时退回邮箱，最后才是占位文案。 */
  function userName(u) {
    var name = String((u && u.name) || '');
    if (name && name.indexOf('@') < 0) return name;
    return String((u && (u.login || u.nickname || u.email)) || '');
  }

  /* 分集进度的读取口（progressAll）还没在现有源码里落地：
     有就数它的 key，没有按 0 显示——不能因为读不到进度就让主页报错。 */
  function watchedCount() {
    try {
      if (typeof progressAll === 'function') {
        var m = progressAll();
        return m ? Object.keys(m).length : 0;
      }
    } catch (e) { /* 进度表坏了也不影响主页其它部分 */ }
    return 0;
  }

  /* 本地追番 → 番剧行：按 id 从 ANI.rows 里找，找不到的跳过（老番/已下架不报错）。 */
  function favRows(n) {
    var ids = {};
    favList().forEach(function (id) { ids[String(id)] = 1; });
    return (ANI.rows || []).filter(function (r) { return ids[String(r[0])]; }).slice(0, n);
  }

  /* /auth/me 兜底：profile 未上线（404）时用这份，字段名与顶栏一致。 */
  function loadMe() {
    var tk = authToken();
    return authFetch('/auth/me', null, 12000, { authorization: 'Bearer ' + tk }, { method: 'GET' })
      .then(function (r) {
        if (r.status === 401) throw new Error('登录已失效，请重新登录');
        var j = r.j || {};
        if (!r.ok || !j.user) throw new Error('资料加载失败（HTTP ' + r.status + '）');
        return j.user;
      });
  }

  /* 资料请求：404 → 退回 /auth/me；401 与其它失败都抛出可读文案，交给调用方出兜底页。
     后端可能回 {ok,user}，也可能直接回用户对象，两种都认。 */
  function loadProfile() {
    var tk = authToken();
    return authFetch('/auth/profile', null, 12000, { authorization: 'Bearer ' + tk }, { method: 'GET' })
      .then(function (r) {
        if (r.status === 404) return loadMe();
        if (r.status === 401) throw new Error('登录已失效，请重新登录');
        var j = r.j || {};
        if (!r.ok) throw new Error('资料加载失败（HTTP ' + r.status + '）');
        if (j.user) return j.user;
        if (j.login || j.email || j.name) return j;
        throw new Error('资料格式不对，稍后重试');
      });
  }

  /* 未登录引导：不请求任何接口，只给一个「登录」按钮（面板是 90-boot.js 的）。
     明确写出「绑定要用账号归属」：B 站绑定在后端按站点 uid 存（bili_bind 表 uid 主键），
     没有账号就没有可归属的行 —— 不登录时连扫码入口都不该出现，否则绑了也无处落地。 */
  function userLoginHTML() {
    /* 不渲染 .pf-hero：那块渐变是给登录后的头像当背景的，未登录时只是一大片空白
       （实测手机端约 300px 纯色块，把「登录 / 注册」挤出首屏）。 */
    return '<div class="sec-h"><h2>我的</h2><span class="sec-sub">未登录</span></div>'
      + '<div class="empty">登录后查看我的主页 —— 追番、观看进度和账号设置都在这里</div>'
      + '<div class="pf-acts-note">'
      + '<p><b>B 站扫码绑定</b>：绑定结果记在你的账号下（每人对自己的绑定负责），登录后才会出现扫码按钮。</p>'
      + '</div>'
      + '<div class="pf-actions"><button class="btn pri" id="pflogin" type="button">登录 / 注册</button></div>';
  }

  /* ---------------- B 站账号（详情弹窗的「弹幕版」播放要用） ----------------
     绑定以扫码为主，粘贴 SESSDATA 兜底（老接口保留）。
     扫码契约（已部署）：
       POST /bili/qr/start {} → {ok,key_id,png:'data:image/png;base64,…'}；未登录 401 / 限流 429 / 缺组件 503；
       GET  /bili/qr/poll?key=<key_id> → {ok,state:'ok|waiting|scanned|expired|error',uname,vip_type}。
       state=ok 时后端已经自动落库（同一条 binding），前端只做刷新，不碰任何 cookie。
     绑定契约：GET /bili/bind → {ok,bound,uname,vip_type,status}，未绑定 {ok:false,error:'not_bound'}；
       POST /bili/bind {sess} → {ok,uname,vip_type,ignored:[…]}，SESSDATA 失效 {ok:false,error:'expired'}；
       DELETE /bili/bind → {ok,deleted:true}。全部带 Authorization: Bearer <站点 token>。
     兜底路径只收 SESSDATA（浏览器 DevTools 里 SESSDATA=… 的值），不收 bili_jct：它等于 B 站账号的
     登录凭证，所以只在提交的那一条请求里出现一次 —— 不进 localStorage、不回显进 DOM
     （输入框提交后立刻清空，失败也不回填）。扫码路径前端从头到尾不接触 cookie。
     未登录时整块不渲染，走 userLoginHTML 的登录引导。 */
  function userHTML(u) {
    var name = userName(u) || '未登录用户';
    var mail = maskEmail(u.email || (String(u.login || '').indexOf('@') >= 0 ? u.login : ''));
    var av = String(u.avatar || '');
    var avHtml = av
      ? '<img class="av" src="' + esc(av) + '" alt="">'
      : '<span class="av">' + esc(name.slice(0, 1).toUpperCase()) + '</span>';
    var rows = favRows(24);
    var cont = typeof contList === 'function' ? contList(24) : [];
    var body;
    if (!ANI.rows || !ANI.rows.length) {
      body = '<div class="empty">番剧数据还没加载好 —— 稍后刷新看看</div>';
    } else if (!rows.length) {
      body = '<div class="empty">还没有追番 —— 打开一部番剧，点详情里的「☆ 追番」</div>'
        + '<div class="pf-actions is-empty"><a class="btn" href="anime">去番剧页</a></div>';
    } else {
      body = '<div class="grid">' + rows.map(function (r) {
        return animeCard(r, { showYear: 1 });
      }).join('') + '</div>';
    }
    /* 观看记录（gamer 的「觀看紀錄」页签）：同一份本地/远端进度，按最近观看排，
       卡片带进度条，点进去直接回详情页继续。没有记录就整页签给空态文案。 */
    var contBody = cont.length
      ? '<div class="grid">' + cont.map(contCard).join('') + '</div>'
      : '<div class="empty">还没有观看记录 —— 进任意一部番剧点「播放」就会开始记录</div>'
        + '<div class="pf-actions is-empty"><a class="btn" href="anime">去番剧页</a></div>';
    return '<div class="pf-hero"></div>'
      + '<div class="pf-id">' + avHtml
      + '<div class="pf-name"><h1>' + esc(name) + '</h1>'
      + (mail ? '<p>' + esc(mail) + '</p>' : '') + '</div></div>'
      + '<div class="pf-stats">'
      + '<div><b>' + favList().length + '</b><i>追番</i></div>'
      + '<div><b>' + watchedCount() + '</b><i>看过</i></div>'
      + '<div><b>' + cont.length + '</b><i>观看记录</i></div>'
      + '</div>'
      + '<div class="pf-actions">'
      + '<button class="btn" id="pfpw" type="button">修改密码</button>'
      + '<button class="btn" id="pfout" type="button">退出登录</button>'
      + '</div>'
      + '<div class="mtabs pf-tabs">'
      + '<button class="mtab on" type="button" data-tab="fav">我的追番（' + rows.length + '）</button>'
      + '<button class="mtab" type="button" data-tab="cont">观看记录（' + cont.length + '）</button>'
      + '</div>'
      + '<div class="pf-body" data-pane="fav">' + body + '</div>'
      + '<div class="pf-body" data-pane="cont" hidden>' + contBody + '</div>';
  }

  /* 登录面板是 90-boot.js 的，成功后它只重绘顶栏（paintAuth），不会重绘 #main。
     所以点完「登录」轮询 token，一落地就重画主页；约 3 分钟没登上就放弃轮询。 */
  function watchLogin() {
    if (userWatch) return;
    var n = 0;
    userWatch = setInterval(function () {
      if (authToken()) {
        clearInterval(userWatch);
        userWatch = 0;
        USER = null;
        renderUser();
        return;
      }
      n += 1;
      if (n > 450) { clearInterval(userWatch); userWatch = 0; }
    }, 400);
  }

  function bindUserLogin() {
    var b = document.getElementById('pflogin');
    if (!b) return;
    b.onclick = function () {
      if (window.__openLogin) window.__openLogin();
      watchLogin();
    };
  }

  function bindUserActions() {
    var pw = document.getElementById('pfpw');
    if (pw) pw.onclick = function () { openAuthPanel('account'); };
    var out = document.getElementById('pfout');
    if (out) out.onclick = function () {
      /* logoutAccount() 的 token 清理在请求返回后的 .then 里（最长等 12s），
         这里先切到未登录引导，别让用户盯着旧资料等网络。 */
      logoutAccount();
      USER = null;
      var m = $('#main');
      if (m) { m.innerHTML = userLoginHTML(); bindUserLogin(); }
    };
    /* 「我的追番 / 观看记录」页签：本地切 hidden，不重画整页（重画会丢滚动位置） */
    var tabs = document.querySelectorAll('.pf-tabs .mtab');
    tabs.forEach(function (b) {
      b.onclick = function () {
        var want = b.getAttribute('data-tab');
        tabs.forEach(function (x) { x.classList.toggle('on', x === b); });
        document.querySelectorAll('.pf-body[data-pane]').forEach(function (p) {
          p.hidden = p.getAttribute('data-pane') !== want;
        });
      };
    });
  }

  /* 页面入口（90-boot.js 的 boot 链与 repaint 都调这里）。
     失败一律出可读兜底，不白屏；USER 有缓存时不重复请求。 */
  /* 顶栏「我的」下拉里的「我的追番 / 观看记录」→ user?tab=fav|cont：进来后自动切页签 */
  function applyUserTab() {
    var m = /[?&]tab=(fav|cont)/.exec(location.search || '');
    if (!m) return;
    var b = document.querySelector('.pf-tabs .mtab[data-tab="' + m[1] + '"]');
    if (b) b.click();
  }

  function renderUser() {
    var main = $('#main');
    if (!main) return;
    if (!authToken()) {
      main.innerHTML = userLoginHTML();
      bindUserLogin();
      return;
    }
    if (USER) {
      main.innerHTML = userHTML(USER);
      bindUserActions();
      applyUserTab();
      return;
    }
    if (!main.querySelector('.pf-hero')) main.innerHTML = '<div class="loading">加载中…</div>';
    loadProfile().then(function (u) {
      USER = u;
      main.innerHTML = userHTML(u);
      bindUserActions();
      applyUserTab();
    }).catch(function (e) {
      main.innerHTML = '<div class="empty">' + esc((e && e.message) || '资料加载失败')
        + '</div><div class="pf-actions"><a class="btn" href="user">重试</a></div>';
    });
  }
