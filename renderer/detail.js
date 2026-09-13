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
const fiveHourHeadline = document.getElementById('fiveHourHeadline');
const weeklyHeadline = document.getElementById('weeklyHeadline');
const fiveHourSub = document.getElementById('fiveHourSub');
const weeklySub = document.getElementById('weeklySub');
const fiveHourLink = document.getElementById('fiveHourLink');
const weeklyLink = document.getElementById('weeklyLink');
const fiveHourAdviceCard = document.getElementById('fiveHourAdviceCard');
const weeklyAdviceCard = document.getElementById('weeklyAdviceCard');
const fiveHourAdviceDot = document.getElementById('fiveHourAdviceDot');
const weeklyAdviceDot = document.getElementById('weeklyAdviceDot');
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

// 한도 카드의 상태색(점 + 왼쪽 바). 실측값이 없어 상태를 모를 때는 중립 회색으로 둔다 -
// 초록(안전)으로 칠하면 "확인해보니 괜찮다"는 잘못된 신호가 된다.
function riskAccent(code) {
  return code ? riskColor(code) : '#4a4e55';
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

// 조언 카드의 헤드라인 한 줄과 그 아래 보조 한 줄. 숫자는 전부 main.js가 계산한 값을 그대로 쓰고,
// Groq은 "그래서 뭘 하라"는 문장만 담당한다.
//
// 세 가지 경우뿐이다.
//   1. 예상 마감이 100% 초과  -> "이 속도면 {t} 뒤 한도 도달" + 초기화까지 남은 시간 + 줄여야 할 속도
//   2. 예상 마감이 100% 이하  -> "이 속도면 구간 끝까지 여유 있습니다" + 예상 마감 사용률
//   3. 구간 초반(데드존)이라 예측 자체가 없음 -> "아직 판단할 수 없습니다"
// 실측값 자체가 없으면(터미널 세션 없음) 예측이 없는 이유가 데드존이 아니므로 따로 구분한다.
function renderAdviceHeadline(headlineEl, subEl, hasData, projectedPct, timeToLimit, atLimitNow, slowdownPct, remaining) {
  headlineEl.classList.remove('hits-limit', 'unknown');

  if (!hasData) {
    headlineEl.classList.add('unknown');
    headlineEl.textContent = STR.noData;
    subEl.textContent = '';
    return;
  }

  if (projectedPct == null) {
    headlineEl.classList.add('unknown');
    headlineEl.textContent = STR.paceTooEarly;
    subEl.textContent = `${STR.remainingLabel}${remaining}`;
    return;
  }

  if (atLimitNow) {
    headlineEl.classList.add('hits-limit');
    headlineEl.textContent = STR.paceAtLimitNow;
    subEl.textContent = `${STR.remainingLabel}${remaining}`;
    return;
  }

  if (timeToLimit != null) {
    headlineEl.classList.add('hits-limit');
    headlineEl.textContent = fmt(STR.paceHitsLimitIn, { t: timeToLimit });
    // 한도 도달 시각과 초기화 시각을 나란히 둬야 "초기화 전에 막힌다"가 뺄셈 없이 보인다.
    subEl.textContent =
      `${STR.remainingLabel}${remaining}` +
      (slowdownPct != null ? ` · ${fmt(STR.paceSlowdown, { n: slowdownPct })}` : '');
    return;
  }

  headlineEl.textContent = STR.paceFitsInWindow;
  subEl.textContent = `${STR.projectedLabel}${projectedPct}% · ${STR.remainingLabel}${remaining}`;
}

// 두 한도를 잇는 줄. 같은 사용이 두 게이지를 동시에 깎으므로, 한쪽 게이지만 봐서는 판단이 어긋난다.
//   5시간 카드: 이 구간을 끝까지 쓰면 주간이 어디까지 가는지 (게이지가 여유로워 보여도 다 쓰면 안 되는 경우)
//   주간 카드: 남은 주간 여유가 5시간 구간 몇 번분인지 (%p보다 훨씬 직관적인 단위)
// 환산 비율은 실측 이력에서 학습하므로 표본이 부족하면 값이 null이고, 그때는 줄을 비워서 숨긴다.
function applyLimitAccent(cardEl, dotEl, risk) {
  const color = riskAccent(risk);
  cardEl.style.borderLeftColor = color;
  dotEl.style.background = color;
}

function renderLinkLines(stats) {
  fiveHourLink.textContent =
    stats.weeklyIfFiveHourFull != null ? fmt(STR.ifFiveHourFull, { x: stats.weeklyIfFiveHourFull }) : '';

  if (stats.weeklyWindowsLeft == null) {
    weeklyLink.textContent = '';
    return;
  }
  const windows = fmt(STR.weeklyInWindows, { h: stats.weeklyHeadroomPct, n: stats.weeklyWindowsLeft });
  weeklyLink.textContent =
    stats.weeklyWindowsPerDay != null
      ? `${windows} (${fmt(STR.weeklyPerDay, { r: stats.weeklyWindowsPerDay })})`
      : windows;
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
  if (!stats) return;
  // 같은 한도의 통계 카드와 조언 카드가 같은 상태색을 갖도록 맞춘다.
  applyLimitAccent(fiveHourAdviceCard, fiveHourAdviceDot, stats.fiveHourRisk);
  applyLimitAccent(weeklyAdviceCard, weeklyAdviceDot, stats.weeklyRisk);
  renderLinkLines(stats);
  renderAdviceHeadline(
    fiveHourHeadline, fiveHourSub,
    stats.fiveHourHasData, stats.fiveHourProjectedPct, stats.fiveHourTimeToLimit,
    stats.fiveHourAtLimitNow, stats.fiveHourSlowdownPct, stats.fiveHourRemaining
  );
  renderAdviceHeadline(
    weeklyHeadline, weeklySub,
    stats.weeklyHasData, stats.weeklyProjectedPct, stats.weeklyTimeToLimit,
    stats.weeklyAtLimitNow, stats.weeklySlowdownPct, stats.weeklyRemaining
  );
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
    <div class="stat-card limit-card" style="border-left-color:${riskAccent(stats.fiveHourRisk)}">
      <div class="limit-title">
        <span class="limit-dot" style="background:${riskAccent(stats.fiveHourRisk)}"></span>
        <span>${STR.fiveHourLimit}</span>
      </div>
      <div class="stat-row">${fiveHourUsageRow}</div>
      <div class="stat-row">${STR.elapsedLabel}${stats.fiveHourElapsed}</div>
      <div class="stat-row">${STR.remainingLabel}${stats.fiveHourRemaining}</div>
      <div class="stat-row">${STR.projectedLabel}<b>${stats.fiveHourProjectedPct != null ? stats.fiveHourProjectedPct + '%' : '-'}</b> ${fiveHourTag}</div>
      ${fiveHourAccLine}
    </div>
    <div class="stat-card limit-card" style="border-left-color:${riskAccent(stats.weeklyRisk)}">
      <div class="limit-title">
        <span class="limit-dot" style="background:${riskAccent(stats.weeklyRisk)}"></span>
        <span>${STR.weeklyLimit}</span>
      </div>
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
