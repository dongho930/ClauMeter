let STR = null; // 현재 언어의 문자열 사전 (main 프로세스가 'locale-data'로 보내줌)
let started = false;

function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}

const statsEl = document.getElementById('stats');
const statusEl = document.getElementById('status');
const adviceBox = document.getElementById('adviceBox');
const adviceSummary = document.getElementById('adviceSummary');
const adviceCards = document.getElementById('adviceCards');
const riskBadge = document.getElementById('riskBadge');
const summaryText = document.getElementById('summaryText');
const fiveHourAdvice = document.getElementById('fiveHourAdvice');
const weeklyAdvice = document.getElementById('weeklyAdvice');
const fiveHourSafePct = document.getElementById('fiveHourSafePct');
const weeklySafePct = document.getElementById('weeklySafePct');
const refreshBtn = document.getElementById('refreshBtn');
const detailHeadingEl = document.getElementById('detailHeading');
const fiveHourCardTitleEl = document.getElementById('fiveHourCardTitle');
const weeklyCardTitleEl = document.getElementById('weeklyCardTitle');

// Groq에는 안전을 위해 항상 영어 코드(safe/caution/danger)로만 riskLevel을 받으므로,
// 색상 판정은 언어와 무관하게 이 코드로만 하고, 화면 표시 문구만 선택된 언어로 번역한다.
function riskColor(code) {
  if (code === 'danger') return '#e53935';
  if (code === 'caution') return '#ffb300';
  return '#43a047';
}

function riskLabel(code) {
  if (code === 'danger') return STR.riskDanger;
  if (code === 'caution') return STR.riskCaution;
  if (code === 'safe') return STR.riskSafe;
  return code || '-';
}

function showAdviceBox(text, isError) {
  adviceSummary.style.display = 'none';
  adviceCards.style.display = 'none';
  adviceBox.style.display = 'block';
  adviceBox.classList.toggle('error', !!isError);
  adviceBox.textContent = text;
}

function showAdviceCards(advice, stats) {
  adviceBox.style.display = 'none';
  adviceBox.classList.remove('error');
  adviceSummary.style.display = 'flex';
  adviceCards.style.display = 'flex';
  riskBadge.textContent = riskLabel(advice.riskLevel);
  riskBadge.style.backgroundColor = riskColor(advice.riskLevel);
  summaryText.textContent = advice.summary || '';
  fiveHourAdvice.textContent = advice.fiveHour || '';
  weeklyAdvice.textContent = advice.weekly || '';
  // 숫자는 개인화 모델(main.js)이 계산한 값을 그대로 쓰고, Groq은 설명만 담당한다.
  fiveHourSafePct.textContent =
    stats && stats.fiveHourSafePct != null ? fmt(STR.recommendedUpTo, { x: stats.fiveHourSafePct }) : '';
  weeklySafePct.textContent =
    stats && stats.weeklySafePct != null ? fmt(STR.recommendedUpTo, { x: stats.weeklySafePct }) : '';
}

function renderStats(stats) {
  if (!stats) {
    statsEl.innerHTML = '';
    return;
  }
  // 구간 초반이라 예측을 내보내지 않은 경우("-")에는 예측 방식 태그도 달지 않는다.
  const methodTag = (hasProjection, modelBased) =>
    hasProjection ? `<span class="model-tag">${modelBased ? STR.modelBasedTag : STR.naiveTag}</span>` : '';
  const fiveHourTag = methodTag(stats.fiveHourProjectedPct != null, stats.fiveHourModelBased);
  const weeklyTag = methodTag(stats.weeklyProjectedPct != null, stats.weeklyModelBased);
  const fiveHourAccLine = accuracyLine(stats.fiveHourAccuracy);
  const weeklyAccLine = accuracyLine(stats.weeklyAccuracy);
  const fiveHourUsageRow = stats.fiveHourHasData
    ? `${STR.usageRateLabel}<b>${stats.fiveHourPct}%</b> <span class="model-tag">${STR.realValueTag}</span>`
    : `${STR.usageRateLabel}<b>${STR.noData}</b> <span class="model-tag">${STR.needsTerminalTag}</span>`;
  const weeklyUsageRow = stats.weeklyHasData
    ? `${STR.usageRateLabel}<b>${stats.weeklyPct}%</b> <span class="model-tag">${STR.realValueTag}</span>`
    : `${STR.usageRateLabel}<b>${STR.noData}</b> <span class="model-tag">${STR.needsTerminalTag}</span>`;
  statsEl.innerHTML = `
    <div class="stat-card">
      <div class="stat-title">${STR.fiveHourLimit}</div>
      <div class="stat-row">${fiveHourUsageRow}</div>
      <div class="stat-row">${STR.elapsedLabel}${stats.fiveHourElapsed}</div>
      <div class="stat-row">${STR.remainingLabel}${stats.fiveHourRemaining}</div>
      <div class="stat-row">${STR.projectedLabel}<b>${stats.fiveHourProjectedPct != null ? stats.fiveHourProjectedPct + '%' : '-'}</b> ${fiveHourTag}</div>
      ${fiveHourAccLine}
    </div>
    <div class="stat-card">
      <div class="stat-title">${STR.weeklyLimit}</div>
      <div class="stat-row">${weeklyUsageRow}</div>
      <div class="stat-row">${STR.elapsedLabel}${stats.weeklyElapsed}</div>
      <div class="stat-row">${STR.remainingLabel}${stats.weeklyRemaining}</div>
      <div class="stat-row">${STR.projectedLabel}<b>${stats.weeklyProjectedPct != null ? stats.weeklyProjectedPct + '%' : '-'}</b> ${weeklyTag}</div>
      ${weeklyAccLine}
    </div>
  `;
}

// 최근 구간들에서 모델 예측이 단순 선형 예측보다 실제로 더 정확했는지 보여주는 검증 로그.
// 기록이 쌓이기 전(완료된 구간이 없을 때)에는 표시하지 않는다.
function accuracyLine(acc) {
  if (!acc) return '';
  const modelText =
    acc.modelMeanAbsErrorPct != null ? fmt(STR.modelErrorLabel, { x: acc.modelMeanAbsErrorPct }) : STR.modelErrorUnknown;
  const naiveText =
    acc.naiveMeanAbsErrorPct != null ? fmt(STR.naiveErrorLabel, { y: acc.naiveMeanAbsErrorPct }) : STR.naiveErrorUnknown;
  return `<div class="stat-row accuracy">${fmt(STR.accuracyLine, { n: acc.sampleCount, model: modelText, naive: naiveText })}</div>`;
}

function errorMessage(result) {
  switch (result.error) {
    case 'no_data':
      return STR.errNoData;
    case 'rate_limited':
      return STR.errRateLimited;
    case 'http':
      return fmt(STR.errHttp, { status: result.status, message: result.message || '' });
    case 'network':
      return fmt(STR.errNetwork, { message: result.message || '' });
    case 'empty_response':
      return STR.errEmpty;
    default:
      return STR.errUnknown;
  }
}

async function loadAdvice(forceRefresh) {
  refreshBtn.disabled = true;
  statusEl.textContent = STR.loading;
  showAdviceBox(STR.pleaseWait, false);

  const result = await window.api.getUsageAdvice(forceRefresh);

  renderStats(result.stats);

  if (result.error) {
    showAdviceBox(errorMessage(result), true);
    statusEl.textContent = '';
  } else if (result.structured && result.advice && typeof result.advice === 'object') {
    showAdviceCards(result.advice, result.stats);
    statusEl.textContent = result.cached ? STR.statusCached : STR.statusFresh;
  } else {
    // 모델이 JSON 형식을 지키지 못한 경우를 대비한 대체 표시
    showAdviceBox(typeof result.advice === 'string' ? result.advice : STR.adviceUnavailable, false);
    statusEl.textContent = result.cached ? STR.statusCached : STR.statusFresh;
  }

  refreshBtn.disabled = false;
}

function applyStaticLocale() {
  document.title = STR.detailWindowTitle;
  detailHeadingEl.textContent = STR.detailHeading;
  fiveHourCardTitleEl.textContent = STR.fiveHourLimit;
  weeklyCardTitleEl.textContent = STR.weeklyLimit;
  refreshBtn.textContent = STR.refreshBtn;
}

window.api.onLocaleData((data) => {
  STR = data.strings;
  document.documentElement.lang = data.lang;
  applyStaticLocale();
  if (!started) {
    started = true;
    loadAdvice(false);
  } else {
    // 창이 열려 있는 동안 설정에서 언어를 바꾼 경우 - 캐시된 조언은 이전 언어라서 새로 받아온다.
    loadAdvice(true);
  }
});

refreshBtn.addEventListener('click', () => loadAdvice(true));
