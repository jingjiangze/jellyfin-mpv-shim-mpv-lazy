/* 三张页面共用一份脚本：首页（今年新番·周/月）、番剧（全量目录）、电影（豆瓣 / TMDB / 剧场版）。
   数据全部走 ./data/*.json，页面本身只是壳。 */
  var $ = function (s) { return document.querySelector(s); };
  var PAGE = document.body.dataset.page || 'home';
  var TYPE = { tv: 'TV', movie: '剧场版', ova: 'OVA', web: '网络', music: '音乐', other: '其他' };
  var WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  /* 模糊搜索：全角转半角 + 去标点空白 + 小写；命中任意位置即算 */
  function nrm(x) {
    return String(x == null ? '' : x).toLowerCase()
      .replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 65248); })
      .replace(/[\s\-_.·・:!?,.'"()\[\]{}<>【】（）~〜]/g, '');
  }
  function hit(hay, q) { return !q || nrm(hay).indexOf(q) !== -1; }

function chip(label, on, attr, val) {
  return '<button class="chip' + (on ? ' on' : '') + '" type="button" ' + attr + '="' + val + '">'
    + label + '</button>';
}

/* 简介文本清洗（正文 + 原文分离）。
   历史背景：早期脚本把「中文简介 + `[简介原文]` + 日文原文（还截到 220 字）」直接写进
   分片的 overview 字段；标记不是前端加的，也不是现在任何脚本加的 —— 属于**脏数据**
   （2026-11-09 实测仍有 228/8316 条）。数据侧 build_site 已清洗，这里再兜一层：
   旧分片 / 边缘缓存里残留的标记不会再显示到界面上，原文也不丢，收进「原文」折叠块。 */
function splitPlot(overview, overviewJa) {
  var mark = '[简介原文]';
  var s = String(overview == null ? '' : overview).replace(/\r\n/g, '\n');
  var i = s.indexOf(mark);
  var zh = s, ja = String(overviewJa == null ? '' : overviewJa);
  if (i >= 0) {
    zh = s.slice(0, i);
    if (!ja.trim()) ja = s.slice(i + mark.length);
  }
  zh = zh.replace(/\n{3,}/g, '\n\n').trim();
  ja = ja.replace(/\n{3,}/g, '\n\n').trim();
  /* 老数据里的原文是被截断的（写库时截到 220 字，末尾常停在半句）；半句不放出来 —— 
     宁可没有「原文」，也不要给人看一句断掉的日文。 */
  if (ja && !/[。．.!?！？…」』）】〕”"]$/.test(ja)) ja = '';
  return { zh: zh || '暂无简介', ja: ja };
}

/* 原文折叠块：只有日文原文才出（样式见 style.css 的 .plot-ja）。 */
function plotJaHtml(ja) {
  return '<details class="plot-ja"><summary>原文</summary><p>' + esc(ja) + '</p></details>';
}
