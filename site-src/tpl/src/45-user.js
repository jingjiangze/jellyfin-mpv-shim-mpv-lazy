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

  /* 未登录引导：不请求任何接口，只给一个「登录」按钮（面板是 90-boot.js 的）。 */
  function userLoginHTML() {
    return '<div class="pf-hero"></div>'
      + '<div class="empty">登录后查看我的主页 —— 追番、观看进度和账号设置都在这里</div>'
      + '<div class="pf-actions"><button class="btn pri" id="pflogin" type="button">登录</button></div>';
  }

  function userHTML(u) {
    var name = userName(u) || '未登录用户';
    var mail = maskEmail(u.email || (String(u.login || '').indexOf('@') >= 0 ? u.login : ''));
    var av = String(u.avatar || '');
    var avHtml = av
      ? '<img class="av" src="' + esc(av) + '" alt="">'
      : '<span class="av">' + esc(name.slice(0, 1).toUpperCase()) + '</span>';
    var rows = favRows(12);
    var body;
    if (!ANI.rows || !ANI.rows.length) {
      body = '<div class="empty">番剧数据还没加载好 —— 稍后刷新看看</div>';
    } else if (!rows.length) {
      body = '<div class="empty">还没有追番 —— 打开一部番剧，点详情里的「☆ 追番」</div>'
        + '<div class="pf-actions"><a class="btn" href="anime">去番剧页</a></div>';
    } else {
      body = '<div class="grid">' + rows.map(function (r) {
        return animeCard(r, { showYear: 1 });
      }).join('') + '</div>';
    }
    return '<div class="pf-hero"></div>'
      + '<div class="pf-id">' + avHtml
      + '<div class="pf-name"><h1>' + esc(name) + '</h1>'
      + (mail ? '<p>' + esc(mail) + '</p>' : '') + '</div></div>'
      + '<div class="pf-stats">'
      + '<div><b>' + favList().length + '</b><i>追番</i></div>'
      + '<div><b>' + watchedCount() + '</b><i>看过</i></div>'
      + '</div>'
      + '<div class="pf-actions">'
      + '<button class="btn" id="pfpw" type="button">修改密码</button>'
      + '<button class="btn" id="pfout" type="button">退出登录</button>'
      + '<a class="btn" href="https://120.48.56.189/qr/" target="_blank" rel="noopener">绑定夸克网盘</a>'
      + '</div>'
      + '<div class="pf-tabs"><button class="on" type="button">我的追番</button></div>'
      + '<div class="pf-body">' + body + '</div>';
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
  }

  /* 页面入口（90-boot.js 的 boot 链与 repaint 都调这里）。
     失败一律出可读兜底，不白屏；USER 有缓存时不重复请求。 */
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
      return;
    }
    if (!main.querySelector('.pf-hero')) main.innerHTML = '<div class="loading">加载中…</div>';
    loadProfile().then(function (u) {
      USER = u;
      main.innerHTML = userHTML(u);
      bindUserActions();
    }).catch(function (e) {
      main.innerHTML = '<div class="empty">' + esc((e && e.message) || '资料加载失败')
        + '</div><div class="pf-actions"><a class="btn" href="user">重试</a></div>';
    });
  }
