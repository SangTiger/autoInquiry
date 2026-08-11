/**
 * 매핑 계획 → 실제 페이지 입력, 그리고 입력 결과 검증.
 *
 * ⚠️ 제출은 하지 않는다. 제출은 fill.mjs 가 `--submit` 플래그를 받았을 때만 수행한다.
 *
 * Radix(shadcn) 주의: 숨은 `select[aria-hidden]` 에 값을 직접 넣으면 React state 와 동기화되지 않아
 * 제출 시 빈 값으로 간다. 반드시 **트리거 클릭 → 옵션 클릭** 경로로만 선택한다.
 */

/**
 * @param {import('playwright').Page} page
 * @param {Array} plan mapFields() 의 plan
 * @returns {Promise<Array<{key:string, ok:boolean, error?:string}>>}
 */
export async function applyPlan(page, plan) {
  const results = [];
  for (const step of plan) {
    try {
      const method = await applyStep(page, step);
      results.push({ key: step.key, ok: true, method });
    } catch (e) {
      results.push({ key: step.key, ok: false, error: e.message.split("\n")[0] });
    }
  }
  return results;
}

async function applyStep(page, step) {
  const loc = page.locator(step.selector).first();
  await loc.waitFor({ state: "visible", timeout: 5000 });
  // 긴 폼은 필드가 뷰포트 밖에 있어 force 클릭조차 거부된다
  await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});

  switch (step.kind) {
    case "text":
    case "textarea":
      await loc.fill(String(step.value ?? ""));
      return;

    case "select-native":
      await loc.selectOption({ label: step.value });
      return;

    case "select-radix": {
      await loc.click();
      // 옵션은 포털로 body 밑에 렌더된다
      const opt = page.getByRole("option", { name: step.value, exact: true }).first();
      await opt.waitFor({ state: "visible", timeout: 5000 });
      await opt.click();
      // 닫힘 확인 — 열린 채로 다음 필드를 누르면 오작동한다
      await page.waitForFunction(
        (sel) => document.querySelector(sel)?.getAttribute("data-state") !== "open",
        step.selector,
        { timeout: 3000 },
      );
      return;
    }

    case "checkbox-radix": {
      const now = (await loc.getAttribute("aria-checked")) === "true";
      if (now !== step.value) await loc.click();
      return;
    }

    case "checkbox-native": {
      if ((await loc.isChecked()) === step.value) return "이미 원하는 상태";
      /**
       * 커스텀 스타일 체크박스는 실제 input 이 span/svg 로 덮여 있거나 화면 밖(x=-2020, opacity 0)에 있어
       * 직접 클릭이 타임아웃된다. 아래 순서로 폴백하되 **전부 실제 click 이벤트를 내는 방법만** 쓴다.
       * `el.checked = v` 직접 대입은 React/Vue 내부 상태와 desync 되어 화면상 체크는 됐는데
       * 제출은 미체크로 가는 사고가 난다 — 그래서 쓰지 않는다.
       */
      const attempts = [
        ["playwright-click", () => loc.setChecked(step.value, { timeout: 4000 })],
        step.labelSelector
          ? ["label-for-click", () => page.locator(step.labelSelector).first().click({ timeout: 4000 })]
          : null,
        ["ancestor-label-click", () => loc.locator("xpath=ancestor::label[1]").click({ timeout: 4000 })],
        ["force-click", () => loc.setChecked(step.value, { force: true, timeout: 4000 })],
        ["dom-native-click", () => loc.evaluate((el) => el.click())],
      ].filter(Boolean);

      for (const [method, run] of attempts) {
        try {
          await run();
        } catch {
          continue;
        }
        if ((await loc.isChecked()) === step.value) return method;
      }
      throw new Error("체크박스 토글 실패 (모든 폴백 소진)");
    }

    default:
      throw new Error(`알 수 없는 위젯 종류: ${step.kind}`);
  }
}

/**
 * 입력이 실제로 반영됐는지 페이지에서 다시 읽어 확인한다.
 * "채우는 코드가 돌았다" 와 "칸에 값이 들어갔다" 는 다른 얘기다.
 */
export async function verifyPlan(page, plan) {
  const mismatches = [];
  for (const step of plan) {
    const loc = page.locator(step.selector).first();
    try {
      if (step.kind === "text" || step.kind === "textarea") {
        const got = await loc.inputValue();
        const want = String(step.value ?? "");
        // 연락처는 사이트가 하이픈을 떼거나 붙이므로 숫자만 비교한다 (리스페이스는 010-1234-5678 → 01012345678)
        const same = step.key.startsWith("phone")
          ? digits(got) === digits(want)
          : got.trim() === want.trim();
        if (!same) mismatches.push({ key: step.key, expected: preview(want), got: preview(got) });
      } else if (step.kind === "select-native") {
        const got = await loc.inputValue();
        if (step.optionValue && got !== step.optionValue)
          mismatches.push({ key: step.key, expected: step.optionValue, got });
      } else if (step.kind === "select-radix") {
        const got = (await loc.innerText()).replace(/\s+/g, " ").trim();
        if (!got.includes(step.value))
          mismatches.push({ key: step.key, expected: step.value, got: preview(got) });
      } else if (step.kind === "checkbox-radix") {
        const got = (await loc.getAttribute("aria-checked")) === "true";
        if (got !== step.value) mismatches.push({ key: step.key, expected: step.value, got });
      } else if (step.kind === "checkbox-native") {
        const got = await loc.isChecked();
        if (got !== step.value) mismatches.push({ key: step.key, expected: step.value, got });
      }
    } catch (e) {
      mismatches.push({ key: step.key, expected: preview(step.value), got: `읽기 실패: ${e.message.split("\n")[0]}` });
    }
  }
  return mismatches;
}

const preview = (v) => String(v ?? "").replace(/\s+/g, " ").slice(0, 40);
const digits = (v) => String(v ?? "").replace(/\D/g, "");
