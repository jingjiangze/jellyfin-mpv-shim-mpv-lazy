  /* 主题：localStorage 里存 light|dark；没存过就跟随系统。必须在首屏渲染前落 data-theme，
     否则深色用户会先闪一下浅色。 */
  var THEME_KEY = 'theme';
  function currentTheme() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      if (t === 'light' || t === 'dark') return t;
    } catch (e) { /* 隐私模式 */ }
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var b = document.getElementById('thm');
    if (b) {
      b.textContent = t === 'dark' ? '☾' : '☀';
      b.setAttribute('aria-label', t === 'dark' ? '切到浅色' : '切到深色');
      b.title = b.getAttribute('aria-label');
    }
  }
  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { }
    applyTheme(next);
  }
  applyTheme(currentTheme());

  /* ---------------- 账号接入（顶栏登录位） ----------------
     契约：邮箱 注册 / 登录 / 验证码 三条 POST，成功响应带 token；
     回调落地时 URL 末尾可能带 #t=<token>，由下方 grabToken 收进 localStorage；
     /auth/me 与 /auth/logout 都要 Authorization: Bearer <token>，未登录回 401。
     常量与 magnet-eps.js 各写一份：两个文件独立加载，不跨文件依赖。 */
  var AUTH_BASE = 'https://120.48.56.189';
  var TOKEN_KEY = 'gh_token';
  /* 待验证邮箱：/auth/register 或 /auth/login 回 need_verify 时记下，
     后续 /auth/verify 与 /auth/resend 都拿它当 email（此时面板已切到验证码视图，拿不到邮箱框）。 */
  var AUTH_PENDING = '';
  /* 当前登录名：/auth/me 回来时记下，账号面板的提示行要用（面板是后开的，拿不到闭包） */
  var AUTH_LOGIN = '';
  function authToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  /* 认证请求统一出口：URL / method / headers / body 与各调用点原实现一致，只多一个超时信号。
     网络慢或后端挂起时 fetch 永不 settle，按钮会一直停在「xx中…」，所以统一 12s 掐断。
     payload 传 null 表示不带 body（/auth/logout）；extraHeaders 给 /auth/password、
     /auth/logout、/auth/me 带 Bearer；opts.method 默认 POST，GET 查询（/auth/me）时显式指定。
     返回 {status, ok, j}：j 是解析后的 JSON，解析失败为 null（调用点自己判）。 */
  function authFetch(path, payload, ms, extraHeaders, opts) {
    opts = opts || {};
    var headers = {};
    var hasBody = payload !== null && payload !== undefined;
    if (hasBody) headers['content-type'] = 'application/json';
    if (extraHeaders) {
      for (var k in extraHeaders) {
        if (Object.prototype.hasOwnProperty.call(extraHeaders, k)) headers[k] = extraHeaders[k];
      }
    }
    var opt = { method: opts.method || 'POST', headers: headers };
    if (hasBody) opt.body = JSON.stringify(payload);
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 12000);
    if (ctl) opt.signal = ctl.signal;
    return fetch(AUTH_BASE + path, opt).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return null; }).then(function (j) {
        return { status: r.status, ok: r.ok, j: j };
      });
    }, function (e) {
      clearTimeout(timer);
      /* 超时（abort）与断网分开提示：前者让用户等一会儿重试，后者多半是掉线 */
      if (ctl && ctl.signal && ctl.signal.aborted) throw new Error('网络慢，请重试');
      throw new Error('网络异常，请检查连接');
    });
  }

  /* 请求期间按钮置灰 + 换进行中文案；返回的函数在 finally 里把原文案与可用态还回去。
     文案都控制在 3–4 字，按钮宽度不会把同排按钮挤走。 */
  function setBusy(btn, text) {
    if (!btn) return function () { };
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = text;
    return function () {
      btn.disabled = false;
      btn.textContent = old;
    };
  }

  /* 三处提示行共用的写法：ok=true 时加 .authok 走成功绿，否则去掉它回到 .autherr 的错误红。
     类名不互换（.autherr 还带 min-height/margin），下一句出错直接切回错误色。 */
  function showMsg(el, msg, ok) {
    if (!el) return;
    el.textContent = msg || '';
    if (ok) el.classList.add('authok');
    else el.classList.remove('authok');
  }

  /* 回调落地：把 #t=<hex> 收进 localStorage，再清掉 hash——token 不留在地址栏/分享链接里。
     hash 不是 t=<32+位 hex> 就原样不动。 */
  (function grabToken() {
    var m = /(?:^|[#&])t=([a-f0-9]{32,})/i.exec(location.hash || '');
    if (!m) return;
    try { localStorage.setItem(TOKEN_KEY, m[1]); } catch (e) { /* 隐私模式忽略 */ }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
  })();

  /* 切清晰度只换海报地址，不重排列表：browse / movie 传 reset === true 保留分页游标，
     无参调用会退回第一页（用户已经滚到第 5 屏时切换会被弹回顶部）。 */
  function repaint() {
    if (PAGE === 'anime') applyBrowse(true);
    else if (PAGE === 'movie') refreshMovie(true);
    else if (PAGE === 'rank') renderRank();
    else renderHome();
  }

  function syncPsz(btn) {
    var hd = PSZ.mode === 'hd';
    btn.textContent = hd ? '高清' : '标准';
    btn.setAttribute('aria-pressed', hd ? 'false' : 'true');
  }

  function initPsz() {
    var btn = document.getElementById('psz');
    if (!btn) return;
    syncPsz(btn);
    btn.onclick = function () {
      PSZ.mode = PSZ.mode === 'hd' ? 'sd' : 'hd';
      try { localStorage.setItem('psz', PSZ.mode); } catch (e) { /* 忽略 */ }
      syncPsz(btn);
      if ($('#mask')) close();
      repaint();
    };
  }

  /* ---------------- 顶栏（HTML 壳里只有一个空 <header>，内容由这里生成） ----------------
     把导航/搜索/计数放进 JS，是为了让每页 HTML 控制在 1KB 以内。
     注意：必须在任何 $('#q') / $('#psz') 绑定之前调用。 */
  /* 未登录入口只出按钮，登录表单收进面板（邮箱一种方式），避免从顶栏直接跳走。
     id 固定 loginbtn，点击交给 paintLoginEntry 绑的 openAuthPanel。 */
  function loginBtnHtml() {
    return '<button class="login" id="loginbtn" type="button">登录</button>';
  }

  /* 顶栏未登录态：清掉已登录时挂在 #cnt 上的退出点击，再换回登录按钮。 */
  function paintLoginEntry(el) {
    el.title = '';
    el.onclick = function (e) {
      if (e && e.target && e.target.id === 'loginbtn') openAuthPanel();
    };
    el.innerHTML = loginBtnHtml();
  }

  /* ---------------- 登录面板（邮箱 / 验证码 / 账号） ----------------
     类名与 style.css 的 .authmask/.authcard 一组对应，改任一边要同步另一边。
     三个视图都是 [data-t] 的 .authbody：email（未登录默认）、verify（验证码）、
     account（登录后点头像进入，改密 + 退出）。
     提交成功后写 token → 关面板 → paintAuth() 重绘顶栏（会再向 /auth/me 核实）。 */
  var authEsc = null;

  function openAuthPanel(mode) {
    if (document.getElementById('authmask')) return;
    /* 账号视图只有登录后才成立；没有 token 时退回邮箱登录视图 */
    if (mode === 'account' && !authToken()) mode = '';
    var mask = document.createElement('div');
    mask.className = 'authmask';
    mask.id = 'authmask';
    mask.innerHTML = '<div class="authcard" role="dialog" aria-modal="true">'
      + '<button class="authx" type="button" aria-label="关闭">×</button>'
      + '<div class="authbody" data-t="email">'
      + '<label class="authfield"><span>邮箱</span><input id="authemail" type="email" autocomplete="username"'
      + ' placeholder="you@example.com"></label>'
      + '<label class="authfield"><span>密码</span><input id="authpw" type="password" autocomplete="current-password"'
      + ' placeholder="至少 8 位"></label>'
      + '<div class="autherr" id="autherr" role="status" aria-live="polite"></div>'
      + '<div class="authacts">'
      + '<button class="btn pri" id="authlogin" type="button">登录</button>'
      + '<button class="btn" id="authreg" type="button">注册</button>'
      + '</div>'
      + '<p class="authhint" id="authemailtip">邮箱只用于登录与找回，不发推广；验证码 10 分钟内有效。</p>'
      + '</div>'
      + '<div class="authbody" data-t="verify" hidden>'
      + '<p class="authhint" id="authverifyhint">验证码已发到你的邮箱，10 分钟内有效。</p>'
      + '<label class="authfield"><span>验证码</span><input id="authcode" inputmode="numeric" maxlength="6"'
      + ' autocomplete="one-time-code" placeholder="6 位数字"></label>'
      + '<p class="authhint" id="authverifytip">没收到？先看垃圾箱；60 秒后可重发</p>'
      + '<div class="autherr" id="authcodeerr" role="status" aria-live="polite"></div>'
      + '<div class="authacts">'
      + '<button class="btn pri" id="authconfirm" type="button">确认</button>'
      + '<button class="btn" id="authresend" type="button">重新发送</button>'
      + '<button class="btn" id="authback" type="button">← 改邮箱</button>'
      + '</div>'
      + '</div>'
      + '<div class="authbody" data-t="account" hidden>'
      + '<p class="authhint" id="accthint">已登录</p>'
      + '<label class="authfield"><span>原密码</span><input id="acctold" type="password"'
      + ' autocomplete="current-password"></label>'
      + '<label class="authfield"><span>新密码</span><input id="acctnew" type="password"'
      + ' autocomplete="new-password" placeholder="至少 8 位"></label>'
      + '<div class="autherr" id="accterr" role="status" aria-live="polite"></div>'
      + '<div class="authacts">'
      + '<button class="btn pri" id="acctsave" type="button">修改密码</button>'
      + '<button class="btn" id="acctout" type="button">退出登录</button>'
      + '</div>'
      + '</div>'
      + '</div>';
    document.body.appendChild(mask);

    mask.querySelector('.authx').onclick = closeAuthPanel;
    mask.addEventListener('click', function (e) { if (e.target.id === 'authmask') closeAuthPanel(); });
    mask.querySelector('#authlogin').onclick = function () { submitAuth('login'); };
    mask.querySelector('#authreg').onclick = function () { submitAuth('register'); };
    mask.querySelector('#authconfirm').onclick = confirmCode;
    mask.querySelector('#authresend').onclick = resendCode;
    /* 「← 改邮箱」只切回 email 视图，不清输入框——邮箱是同一份（已填的值还在 DOM 里），
       用户改一个字重新提交即可，不用从头再打一遍。 */
    mask.querySelector('#authback').onclick = function () {
      showAuthView('email');
      var em = document.getElementById('authemail');
      if (em) { em.focus(); try { em.select(); } catch (e) { /* 忽略 */ } }
    };
    mask.querySelector('#acctsave').onclick = changePassword;
    mask.querySelector('#acctout').onclick = logoutAccount;
    mask.querySelectorAll('.authfield input').forEach(function (inp) {
      /* 验证码框的 Enter 是「确认」、账号框的 Enter 是「改密码」，
         都不能落到邮箱/密码那套「提交登录」上 */
      if (inp.id === 'authcode' || inp.id === 'acctold' || inp.id === 'acctnew') return;
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitAuth('login'); }
      });
    });
    var acode = document.getElementById('authcode');
    if (acode) acode.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); confirmCode(); }
    });
    var acctFields = ['acctold', 'acctnew'].map(function (id) { return document.getElementById(id); });
    acctFields.forEach(function (inp) {
      if (!inp) return;
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); changePassword(); }
      });
    });

    authEsc = function (e) { if (e.key === 'Escape') closeAuthPanel(); };
    document.addEventListener('keydown', authEsc);
    showAuthView(mode === 'account' ? 'account' : 'email');
    var first = document.getElementById(mode === 'account' ? 'acctold' : 'authemail');
    if (first) first.focus();
  }

  /* 视图切换：面板每次都是新建的（关闭即销毁），所以打开时显式指定一次，
     不依赖 innerHTML 里写死的 hidden。 */
  function showAuthView(name) {
    var mask = document.getElementById('authmask');
    if (!mask) return;
    mask.querySelectorAll('.authbody').forEach(function (x) {
      x.hidden = x.getAttribute('data-t') !== name;
    });
    if (name === 'account') {
      var hint = document.getElementById('accthint');
      if (hint) hint.textContent = '已登录' + (AUTH_LOGIN ? '：' + AUTH_LOGIN : '');
    }
  }

  /* 供其它模块（磁力层）唤起登录面板；只暴露一个函数，避免把内部状态泄出去。
     已登录时直接开「账号设置」，否则开邮箱登录，免得已登录用户又看到登录表单。 */
  window.__openLogin = function () {
    openAuthPanel(authToken() ? 'account' : 'email');
  };

  function closeAuthPanel() {
    var m = document.getElementById('authmask');
    if (m && m.parentNode) m.parentNode.removeChild(m);
    if (authEsc) { document.removeEventListener('keydown', authEsc); authEsc = null; }
    /* 重发倒计时绑定的是即将销毁的按钮，面板一关就把定时器停掉 */
    if (authResendTimer) { clearInterval(authResendTimer); authResendTimer = 0; }
  }

  /* 登录/注册共用一个 POST；失败文案优先用后端给的 error（409 已注册 / 401 密码不对 / 429 太频繁）。
     发请求前先做本地格式校验（省一次往返，也避免拿后端的 400 文案当表单提示）；
     请求期间按钮置灰并换「登录中…/发送中…」，防连点重复提交。 */
  function submitAuth(kind) {
    var em = document.getElementById('authemail');
    var pw = document.getElementById('authpw');
    var err = document.getElementById('autherr');
    var bl = document.getElementById('authlogin');
    var br = document.getElementById('authreg');
    if (!em || !pw) return;
    if ((bl && bl.disabled) || (br && br.disabled)) return;
    var email = String(em.value || '').trim();
    var pwv = String(pw.value || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showMsg(err, '邮箱格式看起来不对');
      em.focus();
      return;
    }
    if (pwv.length < 8) {
      showMsg(err, '密码至少 8 位');
      pw.focus();
      return;
    }
    showMsg(err, '');
    /* 点哪个按钮就哪个按钮显示进行中，另一个只置灰不换文案（同排宽度稳定） */
    var main = kind === 'register' ? br : bl;
    var other = kind === 'register' ? bl : br;
    var restore = setBusy(main, kind === 'register' ? '发送中…' : '登录中…');
    if (other) other.disabled = true;
    authFetch(kind === 'register' ? '/auth/register' : '/auth/login', {
      email: email,
      password: pwv
    }).then(function (res) {
      var j = res.j || {};
      if (res.ok && j.token) {
        try { localStorage.setItem(TOKEN_KEY, j.token); } catch (e) { /* 隐私模式忽略 */ }
        closeAuthPanel();
        paintAuth();
        /* 刚登录的账号立刻拉一次远端追番（20-state.js 的 pullFollow，同 IIFE 作用域） */
        try { pullFollow(); } catch (e) { }
        return;
      }
      /* 开了邮箱验证：注册 200 与登录 403 都带 need_verify 且没有 token，切到验证码视图。 */
      if (j.need_verify) {
        AUTH_PENDING = email;
        showAuthVerify(j.hint || j.error || '验证码已发送', j.dev_code);
        return;
      }
      if (res.status === 429) throw new Error(j.error || '尝试太频繁，稍后再试');
      throw new Error(j.error || '请求失败');
    }).catch(function (e) {
      showMsg(err, (e && e.message) || '请求失败');
    }).then(function () {
      restore();
      if (other) other.disabled = false;
    });
  }

  /* 切到「验证码」视图：不是并行的登录方式，所以不新增 tab，只是把 email body 藏起来、
     只留 [data-t="verify"]（验证码仍属邮箱流程）。 */
  function showAuthVerify(hint, devCode) {
    var mask = document.getElementById('authmask');
    if (!mask) return;
    showAuthView('verify');
    var tip = document.getElementById('authverifyhint');
    if (tip) tip.textContent = hint || '验证码已发送';
    var code = document.getElementById('authcode');
    /* 换邮箱重来时清掉上一次的残值；dev_code 只有后端调试期才会给 */
    if (code) code.value = devCode ? String(devCode) : '';
    var ce = document.getElementById('authcodeerr');
    showMsg(ce, '');
    /* 重进验证码视图时把重发按钮复位（上一次的倒计时可能还在跑） */
    if (authResendTimer) { clearInterval(authResendTimer); authResendTimer = 0; }
    var br = document.getElementById('authresend');
    if (br) { br.disabled = false; br.textContent = '重新发送'; }
    if (code) code.focus();
  }

  /* 重发冷却：后端限制 60s 一次，前端先挡住连点，省掉一轮 429 往返。
     计时器挂在模块变量上，面板关闭时由 closeAuthPanel 清掉（按钮已脱离文档，留着只是白跑）。 */
  var RESEND_SECS = 60;
  var authResendTimer = 0;
  function startResendCooldown(btn) {
    if (!btn || !document.getElementById('authmask')) return;
    if (authResendTimer) clearInterval(authResendTimer);
    var left = RESEND_SECS;
    btn.disabled = true;
    btn.textContent = '重新发送(' + left + 's)';
    authResendTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(authResendTimer);
        authResendTimer = 0;
        btn.disabled = false;
        btn.textContent = '重新发送';
        return;
      }
      btn.textContent = '重新发送(' + left + 's)';
    }, 1000);
  }

  /* 确认验证码：POST /auth/verify {email, code}。成功路径与 submitAuth 一致：
     写 token → 关面板 → paintAuth() 重绘顶栏；错码/过期由后端给文案。 */
  function confirmCode() {
    var code = document.getElementById('authcode');
    var err = document.getElementById('authcodeerr');
    var bc = document.getElementById('authconfirm');
    var br = document.getElementById('authresend');
    showMsg(err, '');
    if (!AUTH_PENDING) { showMsg(err, '先填邮箱注册或登录'); return; }
    var v = code ? String(code.value || '').replace(/\s+/g, '') : '';
    if (!/^\d{6}$/.test(v)) { showMsg(err, '验证码是 6 位数字'); if (code) code.focus(); return; }
    /* 只按「确认」自身的禁用态判重入：重发按钮的 60s 冷却期间也可能置灰，
       拿它当闸门会让用户在倒计时里连确认都点不了。 */
    if (bc && bc.disabled) return;
    var restore = setBusy(bc, '确认中…');
    if (br) br.disabled = true;
    authFetch('/auth/verify', { email: AUTH_PENDING, code: v }).then(function (res) {
      var j = res.j || {};
      if (res.ok && j.token) {
        try { localStorage.setItem(TOKEN_KEY, j.token); } catch (e) { /* 隐私模式忽略 */ }
        AUTH_PENDING = '';
        closeAuthPanel();
        paintAuth();
        /* 验证码确认成功也等于刚登录：同样立刻拉一次远端追番 */
        try { pullFollow(); } catch (e) { }
        return;
      }
      throw new Error(j.error || '验证码不对或已过期');
    }).catch(function (e) {
      showMsg(err, (e && e.message) || '验证码不对或已过期');
    }).then(function () {
      restore();
      /* 倒计时没结束时不能把重发按钮放开（那等于给了绕过后端 60s 限流的口子） */
      if (br && !authResendTimer) br.disabled = false;
    });
  }

  /* 重发验证码：POST /auth/resend {email}。成功把后端 hint 写回提示行（顺带刷新 dev_code），
     失败（含 429 太频繁）写 #authcodeerr，不动提示行原有文案。
     请求结束（成功或失败）都进 60s 冷却：失败多半是限流/断网，立刻再点只会再吃一次。 */
  function resendCode() {
    var err = document.getElementById('authcodeerr');
    var tip = document.getElementById('authverifyhint');
    var bc = document.getElementById('authconfirm');
    var br = document.getElementById('authresend');
    showMsg(err, '');
    if (!AUTH_PENDING) { showMsg(err, '先填邮箱注册或登录'); return; }
    /* 冷却中按钮本身就是 disabled，这里再判一次防程序化触发 */
    if ((bc && bc.disabled) || (br && br.disabled)) return;
    if (bc) bc.disabled = true;
    var restore = setBusy(br, '重发中…');
    authFetch('/auth/resend', { email: AUTH_PENDING }).then(function (res) {
      var j = res.j || {};
      if (res.ok && j.ok) {
        if (tip) tip.textContent = j.hint || '验证码已重新发送';
        var code = document.getElementById('authcode');
        if (code && j.dev_code) code.value = String(j.dev_code);
        return;
      }
      if (res.status === 429) throw new Error(j.error || j.hint || '发送太频繁，稍后再试');
      throw new Error(j.error || '发送失败');
    }).catch(function (e) {
      showMsg(err, (e && e.message) || '发送失败');
    }).then(function () {
      if (bc) bc.disabled = false;
      restore();
      startResendCooldown(br);
    });
  }

  /* 改密码：POST /auth/password {old,new}（Bearer）。成功文案走 .authok 绿字（下一次出错
     自动切回 .autherr 红字），顺手清掉两个输入框；失败优先用后端 error
     （403 原密码不对 / 400 新密码太短）。新密码先本地拦一道 8 位下限。 */
  function changePassword() {
    var oldp = document.getElementById('acctold');
    var newp = document.getElementById('acctnew');
    var err = document.getElementById('accterr');
    var bs = document.getElementById('acctsave');
    var bo = document.getElementById('acctout');
    if (!oldp || !newp) return;
    if ((bs && bs.disabled) || (bo && bo.disabled)) return;
    var tk = authToken();
    if (!tk) { showMsg(err, '登录已失效，请重新登录'); return; }
    if (String(newp.value || '').length < 8) {
      showMsg(err, '新密码至少 8 位');
      newp.focus();
      return;
    }
    showMsg(err, '');
    var restore = setBusy(bs, '保存中…');
    if (bo) bo.disabled = true;
    authFetch('/auth/password', {
      old: String(oldp.value || ''),
      new: String(newp.value || '')
    }, 12000, { authorization: 'Bearer ' + tk }).then(function (res) {
      var j = res.j || {};
      if (res.ok && j.ok) {
        oldp.value = '';
        newp.value = '';
        showMsg(err, '密码已更新', true);
        return;
      }
      throw new Error(j.error || '修改失败');
    }).catch(function (e) {
      showMsg(err, (e && e.message) || '修改失败');
    }).then(function () {
      restore();
      if (bo) bo.disabled = false;
    });
  }

  /* 账号面板里的退出：POST /auth/logout（Bearer）→ 清 token → 关面板 → 重绘顶栏。
     退出请求失败（断网）也照常清本地态，否则用户会卡在「退不出去」。 */
  function logoutAccount() {
    var bs = document.getElementById('acctsave');
    var bo = document.getElementById('acctout');
    if ((bs && bs.disabled) || (bo && bo.disabled)) return;
    var tk = authToken();
    if (bs) bs.disabled = true;
    if (bo) bo.disabled = true;
    authFetch('/auth/logout', null, 12000, { authorization: 'Bearer ' + tk })
      .catch(function () { /* 退出请求失败/超时也照常清本地态 */ })
      .then(function () {
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 忽略 */ }
        AUTH_LOGIN = '';
        closeAuthPanel();
        paintAuth();
      });
  }

  /* #cnt 登录位：无 token → 登录入口；有 token → 先乐观占位，再向 /auth/me 核实。
     401（或回 body 不是 ok）清 token 回未登录态；其它失败（断网/后端抖动）保留 token，
     下次刷新再试——不能因为一次网络错误把用户踢下线。 */
  function paintAuth() {
    var el = document.getElementById('cnt');
    if (!el) return;
    var tk = authToken();
    if (!tk) { paintLoginEntry(el); return; }
    el.innerHTML = '<span class="who">登录中…</span>';
    authFetch('/auth/me', null, 12000, { authorization: 'Bearer ' + tk }, { method: 'GET' }).then(function (r) {
      if (r.status === 401) { var e = new Error('login_required'); e.auth = 1; throw e; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      /* 200 但 body 解析不出来按「非鉴权失败」处理：保留 token，顶栏先回未登录态 */
      if (!r.j) throw new Error('bad body');
      return r.j;
    }).then(function (d) {
      var u = (d && d.ok && d.user) || null;
      if (!u) { var e = new Error('login_required'); e.auth = 1; throw e; }
      AUTH_LOGIN = String(u.login || '');
      el.title = '账号设置';
      var av = u.avatar
        ? '<img class="av" src="' + esc(u.avatar) + '" alt="">'
        : '<span class="avt">' + esc(String(u.login || '?').slice(0, 1).toUpperCase()) + '</span>';
      el.innerHTML = av + '<b>' + esc(u.login) + '</b>';
      /* 点头像区块不再直接退出，改成打开账号面板（改密 / 退出都在面板里） */
      el.onclick = function () { openAuthPanel('account'); };
    }).catch(function (e) {
      if (e && e.auth) { try { localStorage.removeItem(TOKEN_KEY); } catch (err) { /* 忽略 */ } }
      paintLoginEntry(el);
    });
  }

  function bootHeader() {
    /* 追番列表复用番剧页（anime.html?fav=1）：把页标识派生成 fav，
       让「追番」高亮、「番剧」不高亮（FAV_ONLY 定义在 50-browse.js）。 */
    var P = PAGE === 'anime' && FAV_ONLY ? 'fav' : PAGE;
    /* 首页 / 番剧 / 排行榜都搜番剧，电影页搜电影 */
    var ph = P === 'movie' ? '搜索电影…' : '搜索番剧…';
    var nav = [['./', 'home', '首页'], ['anime', 'anime', '番剧'], ['anime?fav=1', 'fav', '追番'],
      ['movie', 'movie', '电影'], ['rank', 'rank', '排行榜']]
      .map(function (x) {
        return '<a href="' + x[0] + '"' + (P === x[1] ? ' class="is-on"' : '') + '>' + x[2] + '</a>';
      }).join('');
    var host = document.getElementById('topbar');
    if (!host) return;
    host.innerHTML = '<div class="wrap"><a class="brand" href="./"><i></i>番组<b>计划</b></a>'
      + '<nav class="mainnav">' + nav + '</nav><div class="head-spacer"></div>'
      + '<div class="searchbox"><input id="q" type="search" placeholder="' + ph + '" autocomplete="off"></div>'
      + '<button class="psz" id="psz" type="button" aria-pressed="false">高清</button>'
      + '<button class="thm" id="thm" type="button" aria-label="切换主题">☀</button>'
      + '<span class="cnt" id="cnt"></span>'
      + '<span class="build" id="build">' + (document.body.dataset.build || '') + '</span></div>';
    paintAuth();
    /* 按钮此刻才存在：补一次主题落地，保证图标/aria 与当前主题一致，再绑切换 */
    applyTheme(currentTheme());
    var thm = $('#thm');
    if (thm) thm.onclick = toggleTheme;
  }

  function bootAnime() {
    return jd('anime.json').then(function (d) {
      ANI.poster = d.poster || ''; ANI.posterSd = d.posterSd || '';
      ANI.rows = d.rows || [];
      ANI.extra = d.extra || {}; ANI.year = d.year || new Date().getFullYear();
    });
  }

  document.addEventListener('click', function (e) {
    /* 豆瓣 / TMDB 卡片：就地开详情弹窗，不跳外站。必须 preventDefault，
       否则弹窗与 <a target="_blank"> 跳转会同时发生；⌘/Ctrl/中键 放行原行为。 */
    var mc = e.target.closest && e.target.closest('.mcard');
    if (mc) {
      if (e.metaKey || e.ctrlKey || e.button !== 0) return;
      e.preventDefault();
      openExtModal(mc.dataset.ext, Number(mc.dataset.i));
      return;
    }
    var c = e.target.closest && e.target.closest('.card');
    if (!c) return;
    openModal(Number(c.dataset.id));
  });
  $('#mask') && $('#mask').addEventListener('click', function (e) { if (e.target.id === 'mask') close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  bootHeader();
  bootAnime().then(function () {
    if (PAGE === 'anime') {
      $('#q').placeholder = '在 ' + ANI.rows.length + ' 部里搜…';
      initBrowse();
      var qt = 0;
      $('#q').addEventListener('input', function () {
        clearTimeout(qt);
        qt = setTimeout(applyBrowse, 220);
      });
    } else if (PAGE === 'movie') {
      initMovie();
    } else if (PAGE === 'rank') {
      renderRank();
      bindSearch(renderRank);
    } else {
      renderHome();
      bindSearch(renderHome);
    }
    /* #psz 必须在数据就位之后再绑：它的 repaint 依赖 ANI.rows */
    initPsz();
  }).catch(function (e) {
    $('#main').innerHTML = '<div class="loading">数据加载失败：' + esc(e.message || e) + '</div>';
  });
