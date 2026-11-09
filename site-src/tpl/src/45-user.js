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
      + '<p><b>夸克网盘</b>：绑在站点服务器上，全站共用一份，绑定入口在播放源面板。</p>'
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
  var BILI_BIND_PATH = '/bili/bind';
  var BILI_QR_START = '/bili/qr/start';
  var BILI_QR_POLL = '/bili/qr/poll';
  var BILI_QR_MS = 2000;       // 轮询间隔
  var BILI_QR_MAX = 90;        // 90 × 2s = 180s，与后端二维码有效期对齐
  var BILI_ST = null;          // 上次读到的绑定状态：null=没问过；{bound:true,uname,vip_type} / {bound:false}
  var QR_TIMER = 0;            // 扫码轮询定时器（模块级：切后台/卡片被替换都要清掉）
  var QR_KEY = '';             // 当前二维码 key_id；空 = 没有在跑的扫码流程
  var QR_TRIES = 0;            // 已发出的轮询次数
  var QR_GEN = 0;              // 流程代号：重新生成/停止后，旧回调不再落地
  var QR_BUSY = false;         // 上一轮请求还没回来时跳过这一拍，避免请求堆叠
  var QR_PASTE_OPEN = false;   // 兜底粘贴框是否展开（重画卡片后保持）

  function pfNode(id) { return document.getElementById(id); }

  /* 卡片内容。用 authfield / authhint / mnote / pf-actions 这些既有样式，
     不新增 class 依赖（style.css 不在本次改动范围）。错误行放最上面，重画时一并清掉。
     未绑定态：扫码为主（#pfbili-qr 是二维码挂载点），粘贴 SESSDATA 收进下面的折叠块兜底。
     已绑定态：昵称 + VIP + 解绑，另给「重新扫码」——成功后直接覆盖原绑定。 */
  function pfBiliCard(st) {
    var head = '<div class="mnote" id="pfbili-msg" role="status" aria-live="polite"></div>';
    if (st && st.bound) {
      return head
        + '<p class="authhint">B 站：<b>' + esc(st.uname || '未知昵称') + '</b>'
        + '（会员 VIP' + (Number(st.vip_type) || 0) + '）</p>'
        + '<div class="pf-actions">'
        + '<button class="btn" id="pfreque" type="button">重新扫码</button>'
        + '<button class="btn" id="pfunbind" type="button">解绑</button>'
        + '</div>'
        + '<div id="pfbili-qr"></div>';
    }
    return head
      + '<div id="pfbili-qr"></div>'
      + '<div class="pf-actions">'
      + '<button class="btn pri" id="pfbind-qr" type="button">扫码绑定 B 站账号</button>'
      + '</div>'
      + '<div id="pfbili-paste"' + (QR_PASTE_OPEN ? '' : ' style="display:none"') + '>'
      + '<label class="authfield"><span>B 站 SESSDATA</span>'
      + '<input type="password" id="pfsess" placeholder="粘贴 SESSDATA" autocomplete="off" spellcheck="false"></label>'
      + '<div class="pf-actions"><button class="btn pri" id="pfbind" type="button">绑定</button></div>'
      + '<p class="authhint">只用于读取你账号的播放地址与弹幕；只收 SESSDATA，不收 bili_jct。'
      + 'SESSDATA 等于你 B 站账号的登录凭证，绑定后如不放心可随时解绑。</p>'
      + '</div>'
      + '<p class="authhint">扫码在 B 站官方完成，站点不接触你的密码；绑定后随时可解绑。'
      + '<button class="mnote-btn" id="pfsess-open" type="button">'
      + (QR_PASTE_OPEN ? '收起粘贴框' : '改用粘贴 SESSDATA') + '</button></p>';
  }

  /* 只重画这一块（主页追番列表不跟着重排）。节点已被换页/重绘摘掉就静默放弃。
     重画会把里面的二维码 DOM 一起换掉，先停轮询，别对着不存在的节点白打接口。 */
  function pfBiliPaint(st, msg) {
    var box = pfNode('pfbili');
    if (!box) return;
    pfBiliQrStop();
    if (st && st.bound) QR_PASTE_OPEN = false;   // 绑上以后收起兜底框，下次解绑仍以扫码为主
    box.innerHTML = pfBiliCard(st);
    pfBiliWire();
    if (msg) pfBiliMsg(msg);
  }

  function pfBiliMsg(msg) {
    var el = pfNode('pfbili-msg');
    if (el) el.textContent = msg || '';     // textContent：后端文案不解析成 HTML
  }

  function pfBiliFail(msg) {
    var box = pfNode('pfbili');
    if (!box) return;
    box.innerHTML = '<div class="mnote">' + esc(msg)
      + ' <button class="mnote-btn" id="pfbili-re" type="button">重试</button></div>';
    pfBiliWire();
  }

  function pfBiliWire() {
    var q = pfNode('pfbind-qr');                    // 未绑定：主按钮走扫码
    if (q) q.onclick = function () { pfBiliQrStart(); };
    var rq = pfNode('pfreque');                     // 已绑定：重新扫码覆盖
    if (rq) rq.onclick = function () { pfBiliQrStart(); };
    var so = pfNode('pfsess-open');                 // 兜底：展开/收起粘贴框
    if (so) so.onclick = function () { pfBiliTogglePaste(); };
    var b = pfNode('pfbind');
    if (b) b.onclick = function () { pfBiliDoBind(b); };
    var u = pfNode('pfunbind');
    if (u) u.onclick = function () { pfBiliDoUnbind(u); };
    var r = pfNode('pfbili-re');
    if (r) r.onclick = function () { loadPfBili(true); };
    var sv = pfNode('pfqrsave');
    if (sv) sv.onclick = function () { pfBiliQrSave(); };
  }

  /* ---------------- 扫码绑定（后端 state=ok 时已自己落库，前端只刷新卡片） ---------------- */

  /* 停掉正在跑的流程：gen++ 让在途请求的回调失效，别往换了内容的卡片里写旧状态。 */
  function pfBiliQrStop() {
    QR_GEN += 1;
    if (QR_TIMER) { clearInterval(QR_TIMER); QR_TIMER = 0; }
    QR_KEY = '';
    QR_TRIES = 0;
    QR_BUSY = false;
  }

  /* 只挂起不换代号：切后台时用，回来还能接着同一条 key 轮询。 */
  function pfBiliQrPause() {
    if (QR_TIMER) { clearInterval(QR_TIMER); QR_TIMER = 0; }
    QR_BUSY = false;
  }

  function pfBiliQrText(msg) {
    var el = pfNode('pfbili-qrmsg');
    if (el) el.textContent = msg || '';       // textContent：状态文案不当 HTML 解析
  }

  function pfBiliQrRetryBtn() {
    var box = pfNode('pfbili-qractions');
    if (!box) return;
    box.innerHTML = '<button class="mnote-btn" id="pfqr-re" type="button">重新生成二维码</button>';
    var b = pfNode('pfqr-re');
    if (b) b.onclick = function () { pfBiliQrStart(); };
  }

  /* 二维码区只放一句话（生成失败/限流/缺组件）：可选带一个重新生成按钮。 */
  function pfBiliQrNote(msg, retry) {
    var box = pfNode('pfbili-qr');
    pfBiliQrStop();
    if (!box) return;
    box.innerHTML = '<p class="authhint">' + esc(msg) + '</p>'
      + (retry ? '<div class="pf-actions"><button class="mnote-btn" id="pfqr-re" type="button">重新生成</button></div>' : '');
    var b = pfNode('pfqr-re');
    if (b) b.onclick = function () { pfBiliQrStart(); };
  }

  function pfBiliQrExpired() {
    var box = pfNode('pfbili-qr');
    pfBiliQrStop();
    if (!box) return;
    box.innerHTML = '<div class="pf-actions">'
      + '<button class="mnote-btn" id="pfqr-re" type="button">二维码已过期，点这里重新生成</button></div>';
    var b = pfNode('pfqr-re');
    if (b) b.onclick = function () { pfBiliQrStart(); };
  }

  /* 画二维码。png 只认 base64 图片 data URL —— 后端字段直接进 img src，别的形态不当图渲染。 */
  function pfBiliQrShow(png) {
    var box = pfNode('pfbili-qr');
    if (!box) return;
    var src = String(png || '');
    if (!/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(src)) {
      pfBiliQrNote('二维码数据格式不对，可改用粘贴 SESSDATA', true);
      return;
    }
    box.innerHTML = '<img class="pf-qr" id="pfqrimg" alt="B站登录二维码" src="' + esc(src) + '"'
      + ' style="width:180px;height:180px;display:block;margin:0 auto 8px;border-radius:8px;background:#fff">'
      + '<p class="authhint" id="pfbili-qrmsg" role="status" aria-live="polite"></p>'
      + '<div id="pfbili-qractions">'
      + '<button class="mnote-btn" id="pfqrsave" type="button">保存二维码</button>'
      + '</div>';
    pfBiliQrText('用 B 站 App 扫码 · 180 秒内有效');
  }

  /* 二维码是 data:image/png;base64 的 <img>：手机长按「保存图片」对 data URI 往往无效
     （用户反馈「保存也保存不上」）。转成 Blob URL 再走 <a download> —— Blob 是真正的
     图片资源，浏览器下载器 / 系统相册才认。 */
  function pfBiliQrSave() {
    var img = pfNode('pfqrimg');
    if (!img) return;
    var src = String(img.getAttribute('src') || '');
    var m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
    if (!m) { pfBiliQrNote('二维码不是图片数据，无法保存', true); return; }
    try {
      var bin = atob(m[2].replace(/\s+/g, ''));
      var buf = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      var type = m[1].toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
      var url = URL.createObjectURL(new Blob([buf], { type: type }));
      var a = document.createElement('a');
      a.href = url;
      a.download = 'bilibili-login-qr.' + (type === 'image/png' ? 'png' : 'jpg');
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 20000);
      pfBiliQrNote('已发起保存；手机端没反应就长按二维码图片另存', false);
    } catch (e) {
      pfBiliQrNote('保存失败（' + (e && e.message ? e.message : '浏览器不支持') + '），可长按二维码另存', true);
    }
  }

  /* 一拍 2 秒；网络失败只跳过这一拍，不终止；QR_TRIES 到 90（≈180s）按过期收尾。
     定时器 id 存在闭包里：旧流程的自清理不会误清新流程的 QR_TIMER。 */
  function pfBiliQrPoll() {
    if (QR_TIMER) { clearInterval(QR_TIMER); QR_TIMER = 0; }
    var gen = QR_GEN;
    var timer = setInterval(function () {
      if (gen !== QR_GEN) { clearInterval(timer); return; }   // 已重新生成/停止
      if (!pfNode('pfbili') || !pfNode('pfqrimg')) { pfBiliQrStop(); return; }  // 卡片被换页摘掉
      if (QR_BUSY) return;                                     // 上一拍还没回来，跳过
      if (!QR_KEY) { pfBiliQrStop(); return; }
      if (QR_TRIES >= BILI_QR_MAX) { pfBiliQrExpired(); return; }
      var tk = authToken();
      if (!tk) { pfBiliQrStop(); pfBiliFail('登录已失效，请重新登录后再试'); return; }
      QR_TRIES += 1;
      QR_BUSY = true;
      authFetch(BILI_QR_POLL + '?key=' + encodeURIComponent(QR_KEY), null, 12000,
        { authorization: 'Bearer ' + tk }, { method: 'GET' })
        .then(function (r) {
          QR_BUSY = false;
          if (gen !== QR_GEN) return;
          var j = r.j || {};
          if (r.status === 401) { pfBiliQrStop(); pfBiliFail('登录已失效，请重新登录后再试'); return; }
          if (r.status === 404 || r.status === 410 || j.error === 'expired') { pfBiliQrExpired(); return; }
          if (!r.ok || !j.ok || !j.state) return;               // 其它失败：下一拍再试
          pfBiliQrState(j.state, j);
        }, function () {
          QR_BUSY = false;                                      // 网络抖动：不终止
        });
    }, BILI_QR_MS);
    QR_TIMER = timer;
  }

  function pfBiliQrState(state, j) {
    if (state === 'ok') {
      pfBiliQrStop();
      BILI_ST = { bound: true, uname: j.uname, vip_type: j.vip_type };
      pfBiliPaint(BILI_ST, '扫码绑定成功');       // 重画即清掉二维码 DOM
      return;
    }
    if (state === 'scanned') { pfBiliQrText('已扫码，请在手机上确认'); return; }
    if (state === 'expired') { pfBiliQrExpired(); return; }
    if (state === 'error') {
      pfBiliQrStop();
      pfBiliQrText('扫码状态异常，可重新生成二维码');
      pfBiliQrRetryBtn();
      return;
    }
    pfBiliQrText('等待扫码…');                    // waiting（及未知态）
  }

  /* 生成二维码并立刻开始轮询。限流/缺组件给可重试文案，不把用户卡在扫码上。 */
  function pfBiliQrStart() {
    var tk = authToken();
    if (!tk) { pfBiliFail('登录已失效，请重新登录后再试'); return; }
    pfBiliQrStop();                                // 重开时先停旧流程（gen++）
    var gen = QR_GEN;
    var box = pfNode('pfbili-qr');
    if (box) box.innerHTML = '<p class="authhint">二维码生成中…</p>';
    pfBiliMsg('');
    var done = setBusy(pfNode('pfbind-qr'), '生成中…');
    authFetch(BILI_QR_START, {}, 15000, { authorization: 'Bearer ' + tk }, { method: 'POST' })
      .then(function (r) {
        done();
        if (gen !== QR_GEN) return;                // 期间又点了生成/离开页面
        var j = r.j || {};
        if (r.status === 401) { pfBiliFail('登录已失效，请重新登录后再试'); return; }
        if (r.status === 429) { pfBiliQrNote('操作太频繁，等一分钟再试', true); return; }
        if (r.status === 503) { pfBiliQrNote('服务端缺少二维码组件，可改用粘贴 SESSDATA', true); return; }
        if (!r.ok || !j.ok || !j.key_id || !j.png) {
          pfBiliQrNote('二维码生成失败（HTTP ' + r.status + '），可改用粘贴 SESSDATA', true);
          return;
        }
        QR_KEY = String(j.key_id);
        QR_TRIES = 0;
        pfBiliQrShow(j.png);
        pfBiliQrPoll();
      }, function (e) {
        done();
        if (gen !== QR_GEN) return;
        pfBiliQrNote((e && e.message) || '二维码生成失败，请重试', true);
      });
  }

  /* 兜底粘贴框：展开时聚焦输入框；展开态记在 QR_PASTE_OPEN，重画卡片后仍保持。 */
  function pfBiliTogglePaste() {
    QR_PASTE_OPEN = !QR_PASTE_OPEN;
    var box = pfNode('pfbili-paste');
    if (box) box.style.display = QR_PASTE_OPEN ? '' : 'none';
    var btn = pfNode('pfsess-open');
    if (btn) btn.textContent = QR_PASTE_OPEN ? '收起粘贴框' : '改用粘贴 SESSDATA';
    if (QR_PASTE_OPEN) {
      var inp = pfNode('pfsess');
      if (inp) { try { inp.focus(); } catch (e) { /* 老浏览器忽略 */ } }
    }
  }

  /* 切后台/关标签页就停轮询（省请求也避免拿着过期码空转），回来还有剩余次数就续上。 */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { pfBiliQrPause(); return; }
    if (!QR_TIMER && QR_KEY && QR_TRIES < BILI_QR_MAX && pfNode('pfqrimg')) pfBiliQrPoll();
  });

  function loadPfBili(force) {
    var box = pfNode('pfbili');
    if (!box) return;
    if (!authToken()) { box.innerHTML = ''; return; }   // 未登录：不画这块
    if (BILI_ST && !force) { pfBiliPaint(BILI_ST); return; }
    box.innerHTML = '<div class="mnote">B 站账号读取中…</div>';
    authFetch(BILI_BIND_PATH, null, 12000, { authorization: 'Bearer ' + authToken() }, { method: 'GET' })
      .then(function (r) {
        var j = r.j || {};
        if (j.ok && j.bound) {
          BILI_ST = { bound: true, uname: j.uname, vip_type: j.vip_type };
          pfBiliPaint(BILI_ST);
          return;
        }
        /* 后端「未绑定」是 **200 + {ok:true,bound:false,status:'none'}**（见 server.py
           _bili_bind_get）。这里原来只认 404 / error:'not_bound'，未绑定用户每次都被判成
           「读取失败（HTTP 200）」，卡片只剩「重试」—— 线上用户报的就是这个（绑定入口消失）。 */
        if (j.ok && (j.bound === false || j.status === 'none')
            || j.error === 'not_bound' || r.status === 404) {
          BILI_ST = { bound: false };
          pfBiliPaint(BILI_ST);
          return;
        }
        if (r.status === 401) { pfBiliFail('登录已失效，请重新登录后再试'); return; }
        /* 其它异常把后端的 error 带出来，别再只报状态码（200 无从排查） */
        pfBiliFail('B 站账号状态读取失败（HTTP ' + r.status
                   + (j.error ? ' · ' + String(j.error).slice(0, 40) : '') + '）');
      }, function (e) {
        pfBiliFail((e && e.message) || 'B 站账号状态读取失败');
      });
  }

  /* 用户常整段粘「SESSDATA=xxx; bili_jct=yyy」：只取 SESSDATA 那一格的值，其余字段丢弃
     （SESSDATA 本身是 URL 编码的，值里不会有裸分号/空格）。没写 key 的裸值也认，
     过不过由后端判（expired）。 */
  function pfBiliSess(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var m = /(?:^|[;\s])SESSDATA\s*=\s*([^;\s"']+)/i.exec(s);
    if (m) return m[1];
    return s.replace(/^SESSDATA\s*=\s*/i, '').replace(/[;,"'\s]+$/, '');
  }

  function pfBiliBindMsg(r) {
    var j = r.j || {};
    if (r.status === 401) return '登录已失效，请重新登录后再试';
    if (j.error === 'expired') return '这段 SESSDATA 已失效（或没复制全），请到 B 站重新复制';
    if (j.error) return '绑定失败：' + j.error;
    return '绑定失败（HTTP ' + r.status + '）';
  }

  function pfBiliDoBind(btn) {
    var inp = pfNode('pfsess');
    var sess = pfBiliSess(inp ? inp.value : '');
    if (inp) inp.value = '';                        // 提交即清空：DOM 里不留凭证
    if (!sess) { pfBiliMsg('请先粘贴 SESSDATA'); return; }
    var tk = authToken();
    if (!tk) { pfBiliFail('登录已失效，请重新登录后再试'); return; }
    var done = setBusy(btn, '绑定中…');
    authFetch(BILI_BIND_PATH, { sess: sess }, 20000, { authorization: 'Bearer ' + tk }, { method: 'POST' })
      .then(function (r) {
        var j = r.j || {};
        if (r.ok && j.ok) {
          BILI_ST = { bound: true, uname: j.uname, vip_type: j.vip_type };
          pfBiliPaint(BILI_ST, '绑定成功');
          return;
        }
        done();
        pfBiliMsg(pfBiliBindMsg(r));
      }, function (e) {
        done();
        pfBiliMsg((e && e.message) || '绑定失败，请重试');
      });
  }

  function pfBiliDoUnbind(btn) {
    var tk = authToken();
    if (!tk) { pfBiliFail('登录已失效，请重新登录后再试'); return; }
    var done = setBusy(btn, '解绑中…');
    authFetch(BILI_BIND_PATH, null, 15000, { authorization: 'Bearer ' + tk }, { method: 'DELETE' })
      .then(function (r) {
        var j = r.j || {};
        if (r.ok && j.ok) {
          BILI_ST = { bound: false };
          pfBiliPaint(BILI_ST, '已解绑，可随时重新绑定');
          return;
        }
        done();
        pfBiliMsg(r.status === 401 ? '登录已失效，请重新登录后再试'
          : '解绑失败（HTTP ' + r.status + '），稍后重试');
      }, function (e) {
        done();
        pfBiliMsg((e && e.message) || '解绑失败，请重试');
      });
  }

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
      + '<button class="btn" id="pfquark" type="button">绑定夸克网盘</button>'
      + '</div>'
      + '<div class="pf-bili" id="pfbili"></div>'
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
    /* 夸克绑定：站内弹窗扫码（原来是一个 target=_blank 的链接，用户抱怨「怎么还跳转页面」） */
    var qk = document.getElementById('pfquark');
    if (qk) qk.onclick = function () { openQuarkBindPanel(); };
    var out = document.getElementById('pfout');
    if (out) out.onclick = function () {
      /* logoutAccount() 的 token 清理在请求返回后的 .then 里（最长等 12s），
         这里先切到未登录引导，别让用户盯着旧资料等网络。 */
      logoutAccount();
      USER = null;
      BILI_ST = null;                 // 换账号后 B 站绑定状态要重新问一次
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
      loadPfBili();
      return;
    }
    if (!main.querySelector('.pf-hero')) main.innerHTML = '<div class="loading">加载中…</div>';
    loadProfile().then(function (u) {
      USER = u;
      main.innerHTML = userHTML(u);
      bindUserActions();
      loadPfBili();
    }).catch(function (e) {
      main.innerHTML = '<div class="empty">' + esc((e && e.message) || '资料加载失败')
        + '</div><div class="pf-actions"><a class="btn" href="user">重试</a></div>';
    });
  }
