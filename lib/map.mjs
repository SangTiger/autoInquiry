/**
 * 필드 인벤토리 → 프로필 값 매핑.
 *
 * 사이트마다 필드 작명이 달라도(corporateNm / company / 업체명 / input_X3xXA267i9 ...) 같은 프로필로
 * 커버하기 위해 name·id·label·placeholder·주변텍스트 5개 신호에 키워드 사전을 걸고 점수를 매긴다.
 *
 * 두 단계로 동작한다:
 *   1) **폼 그룹 선택** — 한 페이지에 문의폼·뉴스레터·사이트검색이 섞여 있으므로 어느 그룹이 문의폼인지 고른다
 *   2) 그 그룹 **안에서만** 필드를 매핑한다 (전체 페이지를 대상으로 하면 "이메일 칸 3개" 가 되어 매핑 불가)
 *
 * ⚠️ **애매하면 채우지 않는다.** 필수칸인데 매핑이 안 붙거나 동점이면 unresolved 로 올려 사이트를 건너뛴다.
 *    엉뚱한 칸에 개인정보를 넣어 상대 회사로 전송하는 건 되돌릴 수 없다.
 */

/** camelCase·snake_case 를 공백으로 풀어 단어 경계 매칭이 통하게 만든다 */
const norm = (s) =>
  (s || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.[\]]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();

/** 프로필 키별 키워드 사전 */
const KEYWORDS = {
  company: /회사|업체|기업|법인|상호|브랜드|제품명|company|corporat|\bcorp\b|firm|organization/,
  name: /성함|이름|담당자|신청자|작성자|\bname\b|customer|writer|applicant|manager/,
  phone: /연락처|전화|휴대|핸드폰|폰번|mobile|phone|\btel\d?\b|\bhp\b|cellphone|contact num/,
  email: /이메일|메일|e ?mail|\bmail\b/,
  subject: /제목|타이틀|title|subject|heading/,
  message: /문의|내용|메시지|본문|상세|요청|사항|상담|질문|message|content|inquiry|comment|body|memo|detail|question/,
};

/** select 를 어느 프로필 축으로 볼지 판별 — 순서대로 우선 매칭되므로 좁은 패턴을 앞에 둔다 */
const SELECT_KIND = {
  targetMarket: /목표.?시장|타겟.?시장|진출.?국가|target.?market/,
  inquiryType: /유형|종류|분류|카테고리|항목|서비스|category|type|subject|제목/,
  source: /경로|알게|유입|어떻게|어디서|source|referr|channel|found|hear/,
  location: /소재지|지역|국가|나라|region|location|country/,
};

/** 값이 아니라 안내문인 옵션 (선택 대상에서 제외) */
const PLACEHOLDER_OPT = /^(\(?선택\)?|선택해주세요|선택하세요|choose|select|please|--|=+)/i;

/**
 * 체크박스 분류.
 * "동의" 라는 단어만으로 자동 체크하면 트래킹 동의·마케팅 동의까지 눌러버린다
 * (리스페이스의 "'고객 여정 데이터 수집' 동의"). 그래서 **제출에 필수인 것만** 자동 체크한다.
 */
const STRONG_REQUIRED = /\[필수\]|필수|required/;
const PRIVACY_REQUIRED = /개인정보|개인 정보|privacy|약관|terms/;
const OPTIONAL_AGREE = /\[선택\]|선택 동의|마케팅|광고|수신|뉴스레터|optional|promotion/;

/** 사이트검색 폼처럼 문의와 무관한 그룹을 걸러낸다 */
const SEARCH_GROUP = /search|검색|keyword|query/;

/** 이게 없으면 문의 자체가 성립하지 않는 키 */
const ESSENTIAL = ["message"];

/**
 * @param {{fields:Array, groups:Array}} inventory inspectForm() 결과
 * @param {object} profile profile.json
 * @param {object} [target] targets.json 항목 { overrides, messageSuffix, formIndex }
 */
export function mapFields(inventory, profile, target = {}) {
  const overrides = target.overrides ?? {};
  const messageSuffix = target.messageSuffix ?? "";
  const unresolved = [];
  const warnings = [];
  const plan = [];
  const usedSelectors = new Set();

  /* ───────────── 0) 폼 그룹 선택 ───────────── */

  const picked = pickGroup(inventory, target);
  if (picked.error) return { plan: [], unresolved: [picked.error], warnings, group: null };
  const group = picked.group;
  const fields = inventory.fields.filter((f) => f.group === group.id);
  if (picked.note) warnings.push(picked.note);
  if (inventory.groups.length > 1)
    warnings.push(
      `폼 후보 ${inventory.groups.length}개 중 #${group.id} 선택 (${group.desc}${group.heading ? ` · "${group.heading}"` : ""}, 필드 ${group.fieldCount}개). 다른 폼을 쓰려면 targets.json 에 "formIndex": N`,
    );

  const signals = (f) => ({
    nameId: norm(`${f.name} ${f.id}`),
    label: norm(f.label),
    ph: norm(f.placeholder),
    near: norm(f.nearby),
    text: norm(f.text),
  });

  /* ───────────── 1) 텍스트 계열 매핑 ───────────── */

  const textFields = fields.filter((f) => f.kind === "text" || f.kind === "textarea");

  const score = (key, f) => {
    const s = signals(f);
    const re = KEYWORDS[key];
    let pts = 0;

    // 타입 힌트가 가장 강한 신호다 — input[type=email] 이면 사실상 확정
    if (key === "email" && f.type === "email") pts += 4;
    if (key === "phone" && f.type === "tel") pts += 4;
    if (key === "message" && f.kind === "textarea") pts += 3;

    if (re.test(s.nameId)) pts += 3;
    if (re.test(s.label)) pts += 2;
    if (re.test(s.ph)) pts += 1;
    if (re.test(s.near)) pts += 0.5;

    // 회사명 칸을 성함으로 잡는 오탐이 가장 흔하다 — 회사 신호가 있으면 name 후보 탈락
    if (key === "name" && KEYWORDS.company.test(`${s.nameId} ${s.label} ${s.ph}`)) return 0;
    // 이메일 칸을 message 로 잡는 오탐 방지
    if (key === "message" && f.type === "email") return 0;
    // textarea 를 회사명·성함으로 잡지 않는다
    if ((key === "company" || key === "name") && f.kind === "textarea") return 0;

    return pts;
  };

  /* 연락처가 3칸(010 / 1234 / 5678)으로 쪼개진 폼이 흔하다 — 먼저 처리해 동점 판정에서 빼준다 */
  const phoneParts = handleSplitPhone(textFields, profile, score, plan, usedSelectors, unresolved);

  const textKeys = ["company", "name", "phone", "email", "subject", "message"];
  const candidates = {};
  for (const key of textKeys) {
    if (key === "phone" && phoneParts) {
      candidates[key] = [];
      continue;
    }
    candidates[key] = textFields
      .filter((f) => !usedSelectors.has(f.selector))
      .map((f) => ({ f, pts: score(key, f) }))
      .filter((c) => c.pts > 0)
      .sort((a, b) => b.pts - a.pts);
  }

  // 오버라이드가 있으면 자동매핑보다 우선한다
  for (const [key, sel] of Object.entries(overrides)) {
    if (!sel) continue;
    candidates[key] = [{ f: resolveOverride(sel, inventory.fields), pts: 99, pinned: true }];
  }

  // 점수 높은 순으로 배정 — 한 필드는 한 키에만, 한 키는 한 필드에만
  const assigned = phoneParts ? { phone: true } : {};
  for (const key of textKeys) {
    const list = (candidates[key] ?? []).filter((c) => !usedSelectors.has(c.f.selector));
    if (!list.length) continue;

    // 1·2위가 동점이면 임의로 고르지 않는다
    if (list.length > 1 && list[0].pts === list[1].pts && !list[0].pinned) {
      unresolved.push({
        key,
        reason: "ambiguous",
        detail: `동점 후보: ${list
          .filter((c) => c.pts === list[0].pts)
          .map((c) => c.f.id || c.f.name || c.f.selector)
          .join(", ")} — targets.json overrides 로 지정하면 해결된다`,
      });
      continue;
    }

    const winner = list[0];
    assigned[key] = winner.f;
    usedSelectors.add(winner.f.selector);
    plan.push({
      key,
      selector: winner.f.selector,
      kind: winner.f.kind,
      value: key === "message" ? composeMessage(profile.message, messageSuffix)
           : key === "subject" ? (target.subject ?? profile.subject)
           : profile[key],
      score: winner.pts,
      field: describe(winner.f),
    });
  }

  for (const key of ESSENTIAL) {
    if (!assigned[key]) unresolved.push({ key, reason: "not-found", detail: `${key} 칸을 못 찾았다` });
  }
  if (!assigned.email && !assigned.phone) {
    unresolved.push({ key: "email|phone", reason: "not-found", detail: "회신받을 연락 수단 칸이 없다" });
  }
  for (const key of ["company", "name"]) {
    if (!assigned[key]) warnings.push(`${key} 칸이 없어 건너뛴다 (폼에 해당 칸이 없을 수 있음)`);
  }

  /* ───────────── 1.5) 사이트 고유 질문 답변 (targets.json answers) ───────────── */

  /**
   * 프로필에 대응 값이 없는 사이트 고유 질문("캠페인 희망 날짜" 등)에 답을 넣는다.
   * targets.json 의 `answers` 는 { "라벨 일부": "답변" } 형태이며, 라벨·플레이스홀더에 부분일치시킨다.
   */
  for (const [needle, value] of Object.entries(target.answers ?? {})) {
    const hit = textFields.find(
      (f) => !usedSelectors.has(f.selector) && `${f.label} ${f.placeholder}`.includes(needle),
    );
    if (!hit) {
      warnings.push(`answers 항목 "${needle}" 에 해당하는 칸을 못 찾았다 (라벨이 바뀐 것일 수 있음)`);
      continue;
    }
    usedSelectors.add(hit.selector);
    plan.push({ key: `answer:${needle}`, selector: hit.selector, kind: hit.kind, value, field: describe(hit) });
  }

  /* ───────────── 2) select 계열 매핑 ───────────── */

  for (const f of fields.filter((x) => x.kind === "select-radix" || x.kind === "select-native")) {
    const s = signals(f);
    const blob = `${s.nameId} ${s.label} ${s.ph} ${s.text} ${s.near}`;
    const axis = Object.keys(SELECT_KIND).find((k) => SELECT_KIND[k].test(blob));

    if (!axis) {
      if (f.required) {
        unresolved.push({
          key: "select",
          reason: "unknown-axis",
          detail: `필수 드롭다운인데 유형/경로 어느 쪽인지 판별 못함: "${f.text || f.label || f.selector}"`,
        });
      } else {
        warnings.push(`드롭다운 건너뜀(선택항목, 축 판별 불가): "${(f.label || f.text || f.selector).slice(0, 40)}"`);
      }
      continue;
    }

    const priority =
      axis === "inquiryType"   ? (target.inquiryTypePriority   ?? profile.inquiryTypePriority)
      : axis === "source"      ? (target.sourcePriority        ?? profile.sourcePriority)
      : axis === "location"    ? (target.locationPriority      ?? profile.locationPriority ?? [])
      : axis === "targetMarket"? (target.targetMarketPriority  ?? profile.targetMarketPriority ?? ["아시아", "일본", "글로벌", "기타"])
      : profile.sourcePriority;
    const pick = pickOption(f.options || [], priority);
    if (!pick) {
      unresolved.push({
        key: axis,
        reason: "no-matching-option",
        detail: `우선순위 ${JSON.stringify(priority)} 중 맞는 옵션이 없다. 옵션: ${(f.options || [])
          .map((o) => o.text)
          .join(" / ")}`,
      });
      continue;
    }

    plan.push({
      key: axis,
      selector: f.selector,
      kind: f.kind,
      value: pick.text,
      optionValue: pick.value,
      field: describe(f),
    });
  }

  /* ───────────── 3) 체크박스 (동의) ───────────── */

  for (const f of fields.filter((x) => x.kind === "checkbox-radix" || x.kind === "checkbox-native")) {
    const blob = `${f.label} ${f.nearby} ${f.text}`;
    const key = classifyConsent(f, target.checkConsents ?? []);

    if (!key) {
      if (f.required) {
        unresolved.push({
          key: "checkbox",
          reason: "unknown-checkbox",
          detail: `필수 체크박스인데 성격 판별 못함: "${blob.slice(0, 80)}"`,
        });
      } else {
        warnings.push(
          `체크박스 손대지 않음(필수인지 불명): "${(f.label || f.nearby).slice(0, 50)}" — 체크가 필요하면 targets.json 에 "checkConsents": ["${(f.label || f.nearby).slice(0, 20)}"]`,
        );
      }
      continue;
    }
    const desired = key === "agreeRequired" ? !!profile.agreeRequired : !!profile.agreeMarketing;

    /**
     * 필수로 보이는데 해제로 둔다면 제출이 막힐 수 있어 미리 알려준다.
     * 단 `f.required` 는 조상 블록의 `*` 가 번져 과탐되므로(옆 항목의 필수 표시), 이 경고는
     * **해당 체크박스 자기 문구에 필수 표기가 있을 때만** 낸다. `[선택]` 항목은 대상이 아니다.
     */
    const own = `${f.label} ${f.nearby}`;
    if (desired === false && STRONG_REQUIRED.test(own) && !OPTIONAL_AGREE.test(own))
      warnings.push(`필수 표기 체크박스를 해제 상태로 둔다 → 제출이 거부될 수 있음: "${own.slice(0, 60)}"`);

    plan.push({
      key,
      selector: f.selector,
      kind: f.kind,
      value: desired,
      currentlyChecked: f.checked,
      labelSelector: f.labelSelector,
      field: describe(f),
    });
  }

  /* ───────────── 4) 남은 필수칸 점검 ───────────── */

  const planned = new Set(plan.map((p) => p.selector));
  for (const f of fields) {
    if (planned.has(f.selector)) continue;
    if (f.required) {
      unresolved.push({
        key: "unmapped-required",
        reason: "no-mapping",
        detail: `필수칸인데 매핑 없음: ${describe(f)}`,
      });
    } else if (f.kind !== "checkbox-native" && f.kind !== "checkbox-radix") {
      // 프로필에 대응 값이 없는 사이트 고유 질문(예: "캠페인 희망 날짜") — 빈칸으로 남는다는 걸 알려준다.
      // 검색창·이름 없는 위젯 내부 input(국가번호 셀렉터 등)은 답변 칸이 아니므로 제외한다.
      const name = f.label || f.placeholder || f.name;
      if (name && f.type !== "search") warnings.push(`빈칸으로 둔 항목: "${name.slice(0, 45)}"`);
    }
  }

  return { plan, unresolved, warnings, group };
}

/* ─────────────────────────── 폼 그룹 선택 ─────────────────────────── */

function pickGroup(inventory, target) {
  const groups = inventory.groups.filter((g) => g.fieldCount > 0);
  if (!groups.length) return { error: { key: "form", reason: "not-found", detail: "입력 가능한 폼을 못 찾았다" } };

  if (typeof target.formIndex === "number") {
    const g = groups.find((x) => x.id === target.formIndex);
    if (!g)
      return {
        error: {
          key: "form",
          reason: "bad-formIndex",
          detail: `formIndex ${target.formIndex} 없음. 가능: ${groups.map((x) => x.id).join(", ")}`,
        },
      };
    return { group: g, note: `formIndex ${g.id} 를 targets.json 지정대로 사용` };
  }

  const scored = groups
    .map((g) => {
      const fs = inventory.fields.filter((f) => f.group === g.id);
      const blob = norm(fs.map((f) => `${f.name} ${f.id} ${f.label} ${f.placeholder}`).join(" ") + " " + g.desc);
      let pts = 0;
      if (fs.some((f) => f.kind === "textarea")) pts += 6;
      if (KEYWORDS.email.test(blob) || fs.some((f) => f.type === "email")) pts += 3;
      if (KEYWORDS.phone.test(blob) || fs.some((f) => f.type === "tel")) pts += 2;
      if (KEYWORDS.company.test(blob)) pts += 2;
      if (KEYWORDS.name.test(blob)) pts += 1;
      if (g.submit) pts += 1;
      pts += Math.min(4, fs.filter((f) => f.kind === "text").length) * 0.5;
      if (fs.length <= 1) pts -= 10;
      if (SEARCH_GROUP.test(blob) && fs.length <= 2) pts -= 10;
      return { g, pts };
    })
    .sort((a, b) => b.pts - a.pts);

  if (scored[0].pts <= 0)
    return { error: { key: "form", reason: "not-found", detail: "문의폼으로 볼 만한 그룹이 없다" } };
  if (scored.length > 1 && scored[0].pts === scored[1].pts)
    return {
      error: {
        key: "form",
        reason: "ambiguous-form",
        detail: `문의폼 후보가 동점이다: ${scored
          .filter((s) => s.pts === scored[0].pts)
          .map((s) => `#${s.g.id}(${s.g.desc}, 필드 ${s.g.fieldCount})`)
          .join(" / ")} — targets.json 에 "formIndex": N 으로 지정해라`,
      },
    };

  return { group: scored[0].g };
}

/* ─────────────────────────── 동의 체크박스 판별 ─────────────────────────── */

/**
 * 동의 체크박스를 어떻게 처리할지 가린다.
 *
 * 원칙: **동의는 사람의 결정이다.** 확실히 제출에 필수인 것만 자동 체크하고, 애매한 건 건드리지 않는다.
 * "동의" 라는 단어만으로 체크하면 트래킹 동의까지 눌러버린다(리스페이스 "'고객 여정 데이터 수집' 동의").
 *
 * 판정 순서:
 *   1. targets.json 의 `checkConsents` 에 라벨이 걸리면 체크 (사람이 명시 지정)
 *   2. `[필수]`·`required` 표기 → 체크
 *   3. `개인정보`·`약관` 문구 → 체크 (제출에 법적으로 필요한 동의)
 *   4. `[선택]`·마케팅·수신 표기 → profile.agreeMarketing 따름 (기본 해제)
 *   5. 그 외 → **건드리지 않고 경고**
 *
 * 신호는 label → nearby 순으로만 본다. 넓은 문맥(question)까지 보면 나란히 붙은 옆 항목 문구가
 * 섞여 오분류된다 (퍼그샵은 필수/선택 동의가 붙어 있어 한 덩어리로 읽힌다).
 *
 * @returns {"agreeRequired"|"agreeMarketing"|null}
 */
function classifyConsent(f, checkConsents = []) {
  const own = `${f.label} ${f.nearby}`;

  for (const needle of checkConsents) {
    if (needle && own.includes(needle)) return "agreeRequired";
  }
  for (const src of [f.label, f.nearby]) {
    if (!src) continue;
    if (STRONG_REQUIRED.test(src)) return "agreeRequired";
    if (OPTIONAL_AGREE.test(src)) return "agreeMarketing";
  }
  if (PRIVACY_REQUIRED.test(own)) return "agreeRequired";
  return null;
}

/* ─────────────────────────── 연락처 분할 ─────────────────────────── */

/**
 * 연락처를 여러 칸으로 쪼개 받는 폼(phonenumber1/2/3) 처리.
 * 칸 수와 프로필 전화번호 조각 수가 안 맞으면 채우지 않고 unresolved 로 올린다.
 * @returns {boolean} 분할 처리를 했으면 true
 */
function handleSplitPhone(textFields, profile, score, plan, usedSelectors, unresolved) {
  const phoneish = textFields
    .filter((f) => score("phone", f) > 0)
    .sort((a, b) => a.order - b.order);
  if (phoneish.length < 2) return false;

  const parts = String(profile.phone || "").split(/[^0-9]+/).filter(Boolean);
  let values;
  if (phoneish.length === parts.length) values = parts;
  else if (phoneish.length === 2 && parts.length === 3) values = [parts[0], parts.slice(1).join("")];
  else {
    unresolved.push({
      key: "phone",
      reason: "split-mismatch",
      detail: `연락처 칸 ${phoneish.length}개 vs 번호 조각 ${parts.length}개 — targets.json overrides 로 지정해라`,
    });
    return true;
  }

  phoneish.forEach((f, i) => {
    usedSelectors.add(f.selector);
    plan.push({
      key: `phone${i + 1}`,
      selector: f.selector,
      kind: f.kind,
      value: values[i],
      field: describe(f),
    });
  });
  return true;
}

/* ─────────────────────────── 헬퍼 ─────────────────────────── */

function describe(f) {
  const bits = [f.kind];
  if (f.id) bits.push(`#${f.id}`);
  else if (f.name) bits.push(`[name=${f.name}]`);
  else bits.push(f.selector);
  if (f.label) bits.push(`"${f.label.replace(/\s+/g, " ").slice(0, 30)}"`);
  return bits.join(" ");
}

/**
 * 사이트별 문장(messageSuffix)을 본문에 끼운다.
 * 본문에 `{{suffix}}` 가 있으면 그 자리에 넣고, 없으면 맨 뒤에 붙인다.
 * (맨 뒤 붙이기는 "감사합니다!" 뒤에 문장이 오는 어색한 결과가 나오므로 플레이스홀더 사용을 권한다.)
 */
function composeMessage(base, suffix) {
  const PH = "{{suffix}}";
  if (!base.includes(PH)) return suffix ? `${base.trimEnd()}\n\n${suffix}` : base;
  if (!suffix) return base.replace(new RegExp(`\\n*${PH.replace(/[{}]/g, "\\$&")}\\n*`), "\n\n").trimEnd();
  return base.replace(PH, suffix);
}

/** 우선순위 배열을 위에서부터 훑어 옵션 텍스트/값에 부분일치하는 첫 항목을 고른다 */
function pickOption(options, priority = []) {
  const usable = options.filter((o) => o.text && !PLACEHOLDER_OPT.test(o.text));
  for (const p of priority) {
    const needle = p.toLowerCase();
    const hit =
      usable.find((o) => o.text.toLowerCase() === needle) ||
      usable.find((o) => o.value?.toLowerCase() === needle) ||
      usable.find((o) => o.text.toLowerCase().includes(needle));
    if (hit) return hit;
  }
  return null;
}

/**
 * 오버라이드 셀렉터를 인벤토리 필드로 해석한다.
 * 인벤토리에 없으면 생 셀렉터를 그대로 쓰는 합성 필드를 만든다 (kind 는 text 로 가정).
 */
function resolveOverride(sel, fields) {
  const byId = sel.match(/^#(.+)$/);
  const byName = sel.match(/^\[name=["']?(.+?)["']?\]$/);
  const found = fields.find(
    (f) => (byId && f.id === byId[1]) || (byName && f.name === byName[1]) || f.selector === sel,
  );
  if (found) return found;
  return { selector: sel, kind: "text", id: "", name: "", label: "(override)", options: [] };
}
