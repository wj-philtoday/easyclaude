// ============================================================
// core — 부모 namespace (system / header / sidebar)
//   X(Y) := X.Y 스키마 적용. 함수형 dispatcher + 공통 코드
// ============================================================

window.core = window.core || function(key) {
  return key == null ? core : core[key];
};

// sub 파일들이 attach 될 자리 (core.system, core.header, core.sidebar)
// 공통 코드는 여기에. 현재 모든 시스템 공통은 core.system 안.
