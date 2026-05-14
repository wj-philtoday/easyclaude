// ============================================================
// core.header — 사이드바 최상단 (로고/타이틀/햄버거 토글)
// ============================================================

core.header = core.header || {};
core.header.dom = core.header.dom || {};

(function init() {
  const $ = core.system.dom.$;
  core.header.dom.logo  = $('ec-logo');
  core.header.dom.title = $('ec-title');
  core.header.dom.ham   = $('ec-ham');
})();

// ─── 함수들 ────────────────────────────────────────────────
// 햄버거 토글
core.header.toggleNav = () => {
  const nav = core.sidebar?.dom?.nav;
  nav?.classList.toggle('open');
};

// 로고/타이틀 적용 (cfg 변경 시)
// applyCfg가 core.system.cfg.apply로 옮겨지면 그쪽이 호출. 일단 placeholder.
core.header.applyLogo = (svgContent) => {
  if (core.header.dom.logo) core.header.dom.logo.innerHTML = svgContent || '';
};
core.header.applyTitle = (title) => {
  if (core.header.dom.title) core.header.dom.title.textContent = title || 'easyclaude';
};
