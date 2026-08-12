/**
 * 페이지 DOM → 문의폼 필드 인벤토리 추출.
 *
 * 사이트마다 필드 작명이 다르므로(corporateNm / company / 업체명 / input_X3xXA267i9 ...) 셀렉터를
 * 하드코딩하지 않는다. 대신 후보 요소마다 `data-ff-idx` 를 심고 그 속성을 안정적인 셀렉터로 쓴다.
 *
 * ⚠️ 아무것도 입력하거나 제출하지 않는다. 읽기만 한다.
 *
 * ## 폼 그룹 (중요)
 * 한 페이지에 문의폼·뉴스레터신청·사이트검색이 뒤섞여 있는 사이트가 흔하다(세토웍스는 4개).
 * 전부 한 폼으로 보면 "이메일 칸이 3개" 같은 상황이 되어 매핑이 불가능하다.
 * 그래서 필드를 **그룹**으로 나눠 담고(`<form>` 단위, form 밖 필드는 최근접 공통 조상 단위),
 * 어느 그룹이 문의폼인지는 map.mjs 가 점수로 고른다.
 *
 * ## Radix(shadcn) 대응
 * 보이는 트리거는 `button[role=combobox]` 이고 옵션 목록은 열기 전까지 DOM 에 없다. 하지만 형제로
 * 렌더되는 `select[aria-hidden=true]` 에 옵션이 전부 들어있으므로 **계획 단계에서는 숨은 select 를
 * 읽고, 실제 선택은 트리거 클릭 경로**로 한다.
 */

/** 캡차 탐지 — 자동 우회는 하지 않는다. 사람에게 넘기기 위한 판별용. */
const CAPTCHA_RE = /recaptcha|hcaptcha|turnstile|captcha|kcaptcha/i;

/** 헤더 내비게이션 버튼처럼 문의 제출과 무관한 버튼을 걸러내는 키워드 */
const NAV_BTN_RE = /로그인|회원가입|마이페이지|장바구니|메뉴|닫기|이전|다음|취소|더보기|logout|login|signup/i;

/** 문의 제출 버튼으로 볼 수 있는 텍스트 */
const SUBMIT_BTN_RE = /문의|보내기|제출|전송|등록|접수|신청|상담|문의하기|submit|send|inquiry/i;

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<{fields:Array, groups:Array, captcha:object, url:string, title:string, skippedInvisible:number}>}
 */
export async function inspectForm(page) {
  return page.evaluate(
    ({ captchaSrc, navSrc, submitSrc }) => {
      const CAPTCHA = new RegExp(captchaSrc, "i");
      const NAV = new RegExp(navSrc, "i");
      const SUBMIT = new RegExp(submitSrc, "i");

      const txt = (s) => (s || "").replace(/\s+/g, " ").trim();
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

      /**
       * 화면 밖으로 밀어낸 요소 판별.
       * 아임웹류 사이트는 위젯 원본 폼을 `x=-1986` 같은 캔버스 밖에 숨겨두고 별도 마크업을 보여준다.
       * 이 숨은 사본을 채우면 **화면에는 아무것도 안 들어가고 검증은 통과하는** 최악의 상황이 된다.
       * (체크박스는 예외 — 실제 input 을 일부러 화면 밖에 두고 옆 span 을 보여주는 스타일링이 정상 관행이다.)
       */
      const onCanvas = (el) => {
        const r = el.getBoundingClientRect();
        if (!(r.width || r.height)) return false;
        return r.right > 0 && r.left < document.documentElement.scrollWidth + 50;
      };

      /**
       * `<label>` 로 묶이지 않은 커스텀 폼용 라벨 추정.
       * 필드보다 앞에 있는 가장 가까운 텍스트 블록을 라벨로 본다 ("이메일 *필수", "문의사항" 등).
       */
      const guessLabel = (el) => {
        const isField = (n) => n.matches?.("input, textarea, select, button");
        let node = el;
        for (let up = 0; up < 4 && node && node !== document.body; up++) {
          let sib = node.previousElementSibling;
          while (sib) {
            if (!isField(sib) && !sib.querySelector?.("input, textarea, select")) {
              const v = txt(sib.innerText);
              if (v && v.length <= 40) return v;
            }
            sib = sib.previousElementSibling;
          }
          node = node.parentElement;
        }
        return "";
      };

      /** 라벨 텍스트를 여러 경로로 시도한다. 앞쪽 경로가 더 신뢰도 높다. */
      const labelOf = (el) => {
        const tries = [];
        if (el.getAttribute("aria-label")) tries.push(el.getAttribute("aria-label"));
        try {
          if (el.labels && el.labels[0]) tries.push(el.labels[0].innerText);
        } catch {
          /* 버튼 등 labelable 아닌 요소 */
        }
        if (el.id) {
          const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (l) tries.push(l.innerText);
        }
        const wrapping = el.closest("label");
        if (wrapping) tries.push(wrapping.innerText);
        for (const t of tries) {
          const v = txt(t);
          if (v) return v;
        }
        return "";
      };

      /**
       * 라벨을 못 찾았을 때 쓰는 주변 텍스트.
       * 체크박스는 동의 문구가 형제/부모에 있는 경우가 많아 이쪽이 오히려 핵심 신호다.
       */
      const nearbyOf = (el) => {
        let node = el.parentElement;
        for (let i = 0; i < 3 && node; i++) {
          const v = txt(node.innerText);
          // 폼 전체 텍스트를 긁어오는 걸 막기 위해 길이 상한을 둔다
          if (v && v.length <= 120) return v;
          node = node.parentElement;
        }
        return "";
      };

      /**
       * 필수 표시 탐지.
       * `required` 속성을 쓰는 폼은 드물고, 대부분 라벨 옆에 빨간 `*` 나 "필수" 를 별도 요소로 붙인다.
       * 라벨 텍스트만 봐서는 그 `*` 가 안 잡히므로(리스페이스의 "캠페인 희망 날짜 ... *"),
       * 짧은 조상 블록의 텍스트까지 훑는다. 옆 항목의 `*` 가 섞이면 과탐이 되지만,
       * 과탐은 "채우지 않고 스킵" 쪽으로 기울므로 안전한 방향이다.
       */
      const requiredMark = (el) => {
        // `*` 를 CSS ::after 로 넣는 폼이 많다 (ReCatch) → innerText 로는 절대 안 잡힌다
        const pseudoStar = (node) => {
          for (const e of [node, ...[...node.querySelectorAll("*")].slice(0, 20)]) {
            for (const pe of ["::after", "::before"]) {
              const c = getComputedStyle(e, pe).content;
              if (c && /\*|필수/.test(c)) return true;
            }
          }
          return false;
        };

        let node = el.parentElement;
        for (let i = 0; i < 3 && node; i++) {
          const v = txt(node.innerText);
          if (v.length <= 120 && (/\*|필수|required/i.test(v) || pseudoStar(node))) return true;
          node = node.parentElement;
        }
        return false;
      };

      /**
       * nearby 보다 한 단계 넓은 문맥.
       * 아임웹류 폼은 라벨이 "동의" 한 글자뿐이고 실제 성격("마케팅 동의")은 위쪽 질문 제목에 있다.
       * 단, 넓은 문맥은 옆 항목 문구까지 섞여 들어오므로 **라벨보다 항상 낮은 우선순위로만** 쓴다.
       */
      const questionOf = (el) => {
        let best = "";
        let node = el.parentElement;
        for (let i = 0; i < 5 && node; i++) {
          const v = txt(node.innerText);
          if (v && v.length <= 200 && v.length > best.length) best = v;
          node = node.parentElement;
        }
        return best;
      };

      /* ── 1차: 후보 요소 분류 ── */

      const cands = [];
      let skippedInvisible = 0;

      for (const el of document.querySelectorAll("input, textarea, select, button")) {
        const tag = el.tagName;
        const type = (el.type || "").toLowerCase();
        const role = el.getAttribute("role");
        const ariaHidden = el.getAttribute("aria-hidden") === "true";

        // Radix 가 숨겨둔 native select 는 계획 소스로만 쓰고 필드로 등록하지 않는다
        if (tag === "SELECT" && ariaHidden) continue;
        /**
         * Radix Checkbox 는 보이는 button[role=checkbox] 옆에 미러용 native input 을 하나 더 렌더한다
         * (aria-hidden=true · tabindex=-1 · opacity:0 · pointer-events:none).
         * 이걸 필드로 잡으면 같은 동의를 두 번 토글해 상태가 뒤집힐 수 있다 → 제외하고 button 만 쓴다.
         */
        if (
          tag === "INPUT" &&
          type === "checkbox" &&
          (ariaHidden || el.tabIndex < 0 || !!el.parentElement?.querySelector('button[role="checkbox"]'))
        )
          continue;

        let kind = null;
        if (tag === "TEXTAREA") kind = "textarea";
        else if (tag === "INPUT" && ["text", "tel", "email", "url", "search", "number"].includes(type)) kind = "text";
        else if (tag === "INPUT" && type === "checkbox") kind = "checkbox-native";
        else if (tag === "SELECT") kind = "select-native";
        else if (tag === "BUTTON" && role === "combobox") kind = "select-radix";
        else if (tag === "BUTTON" && role === "checkbox") kind = "checkbox-radix";
        else continue;

        // 접힌 탭·모달 안의 필드는 애초에 입력이 불가능하다
        if (!visible(el)) {
          // CSS 커스텀 스타일 체크박스: 실제 input 을 숨기고 label 을 클릭 타깃으로 쓰는 패턴.
          // label[for] 또는 조상 <label> 이 있으면 살려두고, act.mjs 가 label-click 으로 토글한다.
          if (kind === "checkbox-native") {
            const hasLabelFor = el.id && !!document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            const hasAncestorLabel = !!el.closest("label");
            if (!hasLabelFor && !hasAncestorLabel) {
              skippedInvisible++;
              continue;
            }
            // 살려두되 labelSelector 를 확실히 채울 수 있게 id 가 없으면 조상 label 을 쓸 것임
          } else {
            skippedInvisible++;
            continue;
          }
        }
        // 화면 밖 숨은 사본 폼 제외 (체크박스는 스타일링상 정상적으로 화면 밖에 있을 수 있어 예외)
        if (!kind.startsWith("checkbox") && !onCanvas(el)) {
          skippedInvisible++;
          continue;
        }
        cands.push({ el, kind, tag, type });
      }

      const candEls = new Set(cands.map((c) => c.el));

      /* ── 2차: 그룹 배정 ── */

      const containerToId = new Map();
      const groups = [];

      const describeContainer = (c) => {
        const bits = [c.tagName.toLowerCase()];
        if (c.id) bits.push(`#${c.id}`);
        else if (typeof c.className === "string" && c.className.trim())
          bits.push(`.${c.className.trim().split(/\s+/).slice(0, 2).join(".")}`);
        return bits.join("");
      };

      /** 그룹 바로 위쪽 제목 텍스트 — 사람이 로그에서 어느 폼인지 알아보게 하는 용도 */
      const headingOf = (c) => {
        let node = c;
        for (let i = 0; i < 4 && node; i++) {
          const h = node.querySelector?.("h1,h2,h3,h4,legend,strong");
          if (h) {
            const v = txt(h.innerText);
            if (v) return v.slice(0, 60);
          }
          node = node.parentElement;
        }
        return "";
      };

      const idFor = (container, kindLabel) => {
        if (containerToId.has(container)) return containerToId.get(container);
        const id = groups.length;
        containerToId.set(container, id);
        container.setAttribute("data-ff-group", String(id));
        groups.push({
          id,
          containerKind: kindLabel,
          selector: `[data-ff-group="${id}"]`,
          desc: describeContainer(container),
          heading: headingOf(container),
          submit: null,
        });
        return id;
      };

      /**
       * 제출 버튼 후보 탐색.
       * `type=submit` 만 보면 안 된다 — 세토웍스는 `<input class="regbtn" type="button" onclick=...>` 이고,
       * 국내 사이트는 `<a>`·`<div onclick>` 로 만든 버튼도 흔하다. 대신 실제로 클릭 가능한 요소 타입으로 제한해
       * "문의사항" 같은 라벨 텍스트를 버튼으로 오인하지 않는다.
       */
      const CLICKABLE =
        'button, input[type="submit"], input[type="button"], input[type="image"], a, [role="button"], [onclick]';
      const submitish = (el) => {
        // input[type=submit|button] 은 value 가 비어있거나 영문이어도 제출 버튼으로 인정
        if (el.tagName === "INPUT" && (el.type === "submit" || el.type === "button") && visible(el)) return true;
        const t = txt(el.innerText || el.value);
        return !!t && t.length <= 30 && SUBMIT.test(t) && !NAV.test(t) && visible(el);
      };
      const findSubmits = (root) => [...root.querySelectorAll(CLICKABLE)].filter(submitish);

      /** 컨테이너 안에 문의 제출로 볼 만한 버튼이 있는지 */
      const hasSubmit = (node) => findSubmits(node).length > 0;

      const countCands = (node) => {
        let n = 0;
        for (const c of candEls) if (node.contains(c)) n++;
        return n;
      };

      /**
       * form 밖 필드의 그룹 경계.
       * 단순히 "후보 N개를 품는 최근접 조상" 으로 하면 그리드 레이아웃의 **행(row) 단위로 쪼개진다**
       * (세토웍스: 이메일+연락처 한 행 / 이름+회사 한 행). 그래서 **제출 버튼까지 품는 블록**을 경계로 삼는다.
       * 폼 블록은 자기 제출 버튼을 하나 갖고 있다는 성질을 이용한 것.
       */
      const groupOf = (el) => {
        const f = el.closest("form");
        if (f) return idFor(f, "form");

        let node = el.parentElement;
        for (let i = 0; i < 10 && node && node !== document.body; i++) {
          if (countCands(node) >= 2 && hasSubmit(node)) return idFor(node, "block");
          node = node.parentElement;
        }
        // 제출 버튼을 못 찾는 블록(별도 페이지 이동형 등)은 후보 3개 기준으로 폴백
        node = el.parentElement;
        for (let i = 0; i < 8 && node && node !== document.body; i++) {
          if (countCands(node) >= 3) return idFor(node, "block");
          node = node.parentElement;
        }
        return idFor(el.parentElement || document.body, "block");
      };

      /* ── 3차: 필드 등록 ── */

      let idx = 0;
      const fields = [];

      for (const c of cands) {
        const { el, kind, tag, type } = c;
        const group = groupOf(el);

        let options;
        if (kind === "select-native") {
          options = [...el.options].map((o) => ({ value: o.value, text: txt(o.text) }));
        } else if (kind === "select-radix") {
          // 형제로 붙는 숨은 native select 에서 옵션 목록을 읽는다
          let host = el.parentElement;
          let hidden = null;
          for (let i = 0; i < 3 && host && !hidden; i++) {
            hidden = host.querySelector('select[aria-hidden="true"]');
            host = host.parentElement;
          }
          options = hidden ? [...hidden.options].map((o) => ({ value: o.value, text: txt(o.text) })) : [];
        }

        el.setAttribute("data-ff-idx", String(idx));
        const label = labelOf(el) || guessLabel(el);
        const nearby = nearbyOf(el);
        const question = questionOf(el);
        // 항목 제목 (라벨과 별개). 동의 체크박스는 "[필수] 개인정보 수집 및 이용" 이 제목,
        // "네, 동의합니다." 가 라벨인 구조가 흔하다 (ReCatch).
        const sectionTitle = guessLabel(el);

        fields.push({
          order: idx,
          group,
          selector: `[data-ff-idx="${idx}"]`,
          kind,
          tag,
          type,
          name: el.getAttribute("name") || "",
          id: el.id || "",
          placeholder: el.getAttribute("placeholder") || "",
          label,
          nearby,
          question,
          sectionTitle,
          // Radix 트리거는 라벨이 없고 버튼 텍스트("문의 유형을 선택해주세요")가 유일한 단서다
          text: txt(el.innerText || el.value),
          // 커스텀 스타일 체크박스는 실제 input 이 가려져 있어 라벨을 클릭해야 토글된다
          labelSelector: el.id ? `label[for="${el.id}"]` : null,
          // required 속성을 안 쓰고 라벨 옆에 * 만 붙이는 사이트가 많다 (퍼그샵·리스페이스가 그렇다)
          required:
            !!el.required || el.getAttribute("aria-required") === "true" || requiredMark(el),
          checked: kind.startsWith("checkbox")
            ? el.getAttribute("aria-checked") === "true" || !!el.checked
            : undefined,
          options,
        });
        idx++;
      }

      /* ── 4차: 그룹별 제출 버튼 ── */

      const submitOf = (container, lastFieldOrder) => {
        // 폼 안 → 없으면 한 단계 위 컨테이너 (아임웹 등은 버튼이 폼 밖에 있다)
        let hits = findSubmits(container);
        if (!hits.length && container.parentElement) hits = findSubmits(container.parentElement);
        if (!hits.length) return null;

        const el = hits[hits.length - 1];
        el.setAttribute("data-ff-submit", String(lastFieldOrder));
        return { selector: `[data-ff-submit="${lastFieldOrder}"]`, text: txt(el.innerText || el.value) };
      };

      for (const g of groups) {
        const container = document.querySelector(g.selector);
        const own = fields.filter((f) => f.group === g.id);
        g.fieldCount = own.length;
        if (container && own.length) g.submit = submitOf(container, own[own.length - 1].order);
      }

      /* ── 캡차 ── */

      const srcs = [...document.querySelectorAll("script")].map((s) => s.src).filter(Boolean);
      const iframes = [...document.querySelectorAll("iframe")].map((f) => f.src).filter(Boolean);
      const hints = [...srcs, ...iframes].filter((s) => CAPTCHA.test(s));
      const captcha = {
        detected:
          hints.length > 0 ||
          typeof window.grecaptcha !== "undefined" ||
          typeof window.turnstile !== "undefined" ||
          typeof window.hcaptcha !== "undefined",
        hints,
      };

      return { fields, groups, captcha, url: location.href, title: document.title, skippedInvisible };
    },
    { captchaSrc: CAPTCHA_RE.source, navSrc: NAV_BTN_RE.source, submitSrc: SUBMIT_BTN_RE.source },
  );
}
