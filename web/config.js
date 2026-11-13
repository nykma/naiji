/**
 * 奶记 · 运行时配置（普通 <script>，非 ES Module）
 *
 * app.js 在 module 里通过 window.NAIJI_CONFIG 读取默认 API 基址。
 * CSP 禁止内联脚本，因此配置必须放在这个独立文件里。
 *
 * 用法：
 * 1) 同源部署（server 同时托管 web/，默认）：保持 apiBase: ''，请求走当前页面同源的 /api/*。
 * 2) 前后端分离部署（web/ 放在任意静态主机，server 在另一台机器/端口）：
 *      把 apiBase 改成后端地址，如 'http://192.168.1.10:3000'。
 *    这样无需改代码也能切换：页面 URL 加 ?api=http://192.168.1.10:3000
 *    （会持久化到 localStorage['naiji.apiBase']，下次打开仍生效）。
 * 3) 优先级：URL 的 ?api= 参数 > localStorage['naiji.apiBase'] > 本文件 apiBase。
 */
window.NAIJI_CONFIG = {
  apiBase: '',
};
