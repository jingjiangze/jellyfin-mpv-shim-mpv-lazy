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
