// 언어 드롭다운에 쓰는 국기 아이콘 (인라인 SVG, 전부 3:2 비율의 viewBox="0 0 3 2").
// 네이티브 <select><option>은 이미지를 담을 수 없어서(에뮬레이터로 국기 이모지를 못 띄우는 Windows 폰트 문제도 있음),
// calibrate.js가 이 SVG로 직접 커스텀 드롭다운을 그린다.
const FLAGS = {
  ko: `<svg viewBox="0 0 3 2" xmlns="http://www.w3.org/2000/svg">
    <rect width="3" height="2" fill="#fff"/>
    <path d="M1.5,0.5 A0.5,0.5 0 0,1 1.5,1.5 A0.25,0.25 0 0,1 1.5,1 A0.25,0.25 0 0,0 1.5,0.5 Z" fill="#cd2e3a"/>
    <path d="M1.5,0.5 A0.5,0.5 0 0,0 1.5,1.5 A0.25,0.25 0 0,0 1.5,1 A0.25,0.25 0 0,1 1.5,0.5 Z" fill="#0047a0"/>
    <g fill="#000">
      <rect x="0.5" y="0.32" width="0.3" height="0.045"/><rect x="0.5" y="0.42" width="0.3" height="0.045"/><rect x="0.5" y="0.52" width="0.3" height="0.045"/>
      <rect x="2.2" y="0.32" width="0.3" height="0.045"/><rect x="2.2" y="0.42" width="0.3" height="0.045"/><rect x="2.2" y="0.52" width="0.3" height="0.045"/>
      <rect x="0.5" y="1.43" width="0.3" height="0.045"/><rect x="0.5" y="1.53" width="0.3" height="0.045"/><rect x="0.5" y="1.63" width="0.3" height="0.045"/>
      <rect x="2.2" y="1.43" width="0.3" height="0.045"/><rect x="2.2" y="1.53" width="0.3" height="0.045"/><rect x="2.2" y="1.63" width="0.3" height="0.045"/>
    </g>
  </svg>`,
  en: `<svg viewBox="0 0 3 2" xmlns="http://www.w3.org/2000/svg">
    <rect width="3" height="2" fill="#fff"/>
    <g fill="#b22234">
      <rect y="0" width="3" height="0.154"/><rect y="0.308" width="3" height="0.154"/><rect y="0.615" width="3" height="0.154"/>
      <rect y="0.923" width="3" height="0.154"/><rect y="1.231" width="3" height="0.154"/><rect y="1.538" width="3" height="0.154"/><rect y="1.846" width="3" height="0.154"/>
    </g>
    <rect width="1.2" height="1.077" fill="#3c3b6e"/>
  </svg>`,
  es: `<svg viewBox="0 0 3 2" xmlns="http://www.w3.org/2000/svg">
    <rect width="3" height="2" fill="#aa151b"/>
    <rect y="0.5" width="3" height="1" fill="#f1bf00"/>
  </svg>`,
  fr: `<svg viewBox="0 0 3 2" xmlns="http://www.w3.org/2000/svg">
    <rect width="1" height="2" fill="#0055a4"/>
    <rect x="1" width="1" height="2" fill="#fff"/>
    <rect x="2" width="1" height="2" fill="#ef4135"/>
  </svg>`,
  de: `<svg viewBox="0 0 3 2" xmlns="http://www.w3.org/2000/svg">
    <rect width="3" height="0.667" fill="#000"/>
    <rect y="0.667" width="3" height="0.667" fill="#dd0000"/>
    <rect y="1.333" width="3" height="0.667" fill="#ffce00"/>
  </svg>`,
  pt: `<svg viewBox="0 0 3 2" xmlns="http://www.w3.org/2000/svg">
    <rect width="1.2" height="2" fill="#046a38"/>
    <rect x="1.2" width="1.8" height="2" fill="#da291c"/>
    <circle cx="1.2" cy="1" r="0.35" fill="#ffce00" stroke="#046a38" stroke-width="0.04"/>
  </svg>`,
  ja: `<svg viewBox="0 0 3 2" xmlns="http://www.w3.org/2000/svg">
    <rect width="3" height="2" fill="#fff"/>
    <circle cx="1.5" cy="1" r="0.55" fill="#bc002d"/>
  </svg>`,
  zh: `<svg viewBox="0 0 3 2" xmlns="http://www.w3.org/2000/svg">
    <rect width="3" height="2" fill="#de2910"/>
    <polygon points="0.5,0.15 0.5353,0.2515 0.6427,0.2536 0.5571,0.3185 0.5882,0.4214 0.5,0.36 0.4118,0.4214 0.4429,0.3185 0.3573,0.2536 0.4647,0.2515" fill="#ffde00"/>
    <g fill="#ffde00">
      <circle cx="0.95" cy="0.15" r="0.035"/>
      <circle cx="1.08" cy="0.32" r="0.035"/>
      <circle cx="1.05" cy="0.53" r="0.035"/>
      <circle cx="0.88" cy="0.63" r="0.035"/>
    </g>
  </svg>`,
  ru: `<svg viewBox="0 0 3 2" xmlns="http://www.w3.org/2000/svg">
    <rect width="3" height="0.667" fill="#fff"/>
    <rect y="0.667" width="3" height="0.667" fill="#0039a6"/>
    <rect y="1.333" width="3" height="0.667" fill="#d52b1e"/>
  </svg>`,
  it: `<svg viewBox="0 0 3 2" xmlns="http://www.w3.org/2000/svg">
    <rect width="1" height="2" fill="#009246"/>
    <rect x="1" width="1" height="2" fill="#fff"/>
    <rect x="2" width="1" height="2" fill="#ce2b37"/>
  </svg>`,
  nl: `<svg viewBox="0 0 3 2" xmlns="http://www.w3.org/2000/svg">
    <rect width="3" height="0.667" fill="#ae1c28"/>
    <rect y="0.667" width="3" height="0.667" fill="#fff"/>
    <rect y="1.333" width="3" height="0.667" fill="#21468b"/>
  </svg>`,
  pl: `<svg viewBox="0 0 3 2" xmlns="http://www.w3.org/2000/svg">
    <rect width="3" height="1" fill="#fff"/>
    <rect y="1" width="3" height="1" fill="#dc143c"/>
  </svg>`,
};
