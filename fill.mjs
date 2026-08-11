#!/usr/bin/env node
/**
 * 문의폼 자동 작성기 — 프로필 1개 + 자동 필드매핑으로 임의 사이트 문의폼을 채운다.
 *
 * 사이트별 매크로를 N개 만드는 대신, profile.json 하나와 키워드 사전 하나로 커버한다.
 * 좌표 녹화형 매크로와 달리 셀렉터 기반이라 해상도·렌더 타이밍에 영향받지 않는다.
 *
 * ⚠️ **기본은 dry-run 이다.** 칸을 채우고 스크린샷만 남기고 멈춘다.
 *    실제 전송은 `--submit` 을 명시할 때만 한다 — 오타사를 상대 회사에 보내는 건 되돌릴 수 없다.
 * ⚠️ 캡차가 감지되면 자동으로 우회하지 않는다. 사람에게 넘긴다.
 * ⚠️ 필수칸 매핑이 하나라도 미해결이면 그 사이트는 채우지 않고 건너뛴다.
 *
 * 실행:
 *   node fill.mjs --url <URL>              # 단일, dry-run
 *   node fill.mjs --all                    # targets.json 전체, dry-run
 *   node fill.mjs --url <URL> --submit     # 실제 전송
 * 옵션:
 *   --headless   창 없이 (기본은 창 띄움 — 사람이 눈으로 확인하는 게 안전장치다)
 *   --json       결과를 JSON 으로 출력
 *   --force      log.csv 에 이미 sent 로 남은 URL 도 다시 처리
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { inspectForm } from "./lib/inspect.mjs";
import { mapFields } from "./lib/map.mjs";
import { applyPlan, verifyPlan } from "./lib/act.mjs";

const ROOT = path.resolve(import.meta.dirname);
const OUT = path.join(ROOT, "out");
const SHOTS = path.join(OUT, "shots");
const LOG = path.join(OUT, "log.csv");

/* ─────────────────────────── 인자 ─────────────────────────── */

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const OPTS = {
  url: val("url"),
  all: flag("all"),
  submit: flag("submit"),
  headless: flag("headless"),
  json: flag("json"),
  force: flag("force"),
};

if (!OPTS.url && !OPTS.all) {
  console.error("사용법: node fill.mjs --url <URL> [--submit]  또는  node fill.mjs --all");
  process.exit(2);
}

/* ─────────────────────────── 설정 로드 ─────────────────────────── */

const profile = readJson(path.join(ROOT, "profile.json"));
const targetsFile = fs.existsSync(path.join(ROOT, "targets.json"))
  ? readJson(path.join(ROOT, "targets.json"))
  : { targets: [] };

const targets = OPTS.url
  ? [targetsFile.targets.find((t) => t.url === OPTS.url) ?? { url: OPTS.url }]
  : targetsFile.targets;

if (!targets.length) {
  console.error("처리할 대상이 없다. targets.json 에 URL 을 넣거나 --url 을 써라.");
  process.exit(2);
}

const alreadySent = loadSentUrls();

/* ─────────────────────────── 실행 ─────────────────────────── */

const report = [];
const browser = await chromium.launch({ headless: OPTS.headless });

try {
  for (const [i, target] of targets.entries()) {
    if (target._skip) {
      if (!OPTS.json) console.log(`\n⬜ SKIP  ${target.url}  (${target._메모 ?? "_skip:true"})`);
      continue;
    }
    if (i > 0) await sleep(3000 + Math.floor(Math.random() * 4000)); // 상대 서버 배려
    const r = await processTarget(browser, target);
    report.push(r);
    appendLog(r);
    if (!OPTS.json) printHuman(r);
  }
} finally {
  await browser.close();
}

if (OPTS.json) console.log(JSON.stringify({ dryRun: !OPTS.submit, results: report }, null, 2));

const bad = report.filter((r) => r.status === "skipped" || r.status === "failed");
process.exit(bad.length ? 1 : 0);

/* ─────────────────────────── 사이트 1개 처리 ─────────────────────────── */

async function processTarget(browser, target) {
  const url = target.url;
  const base = {
    ts: new Date().toISOString(),
    url,
    status: "skipped",
    mapped: [],
    unresolved: [],
    warnings: [],
    http: "",
    shots: [],
  };

  if (OPTS.submit && alreadySent.has(url) && !OPTS.force) {
    return { ...base, unresolved: [{ reason: "already-sent", detail: "log.csv 에 이미 전송 기록이 있다 (--force 로 무시)" }] };
  }

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "ko-KR" });
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // 클라이언트 렌더 폼(Next.js 등)이 그려질 시간을 준다
    await page.waitForTimeout(1500);

    // 팝업 자동 닫기
    // 공통 패턴(×, 닫기, 확인, close 버튼)을 자동 시도한다.
    // targets.json 에 "dismissPopup": "일주일간 보지않기" 처럼 지정하면 해당 텍스트도 추가로 시도한다.
    await dismissPopups(page, target.dismissPopup);

    // 문의 버튼 클릭이 필요한 사이트 (모달·별도 페이지형)
    // targets.json 에 "clickToOpen": "마케팅 문의하기" 처럼 버튼 텍스트를 지정하면 클릭 후 폼을 찾는다.
    if (target.clickToOpen) {
      const btn = page.getByText(target.clickToOpen, { exact: false }).first();
      await btn.click({ timeout: 8000 }).catch(() =>
        page.locator(target.clickToOpen).first().click({ timeout: 5000 }).catch(() => {}),
      );
      await page.waitForTimeout(1500);
    }

    // Radix 드롭다운 hydration 대기 — 숨은 select 에 옵션이 채워질 때까지 (최대 4초)
    await page.waitForFunction(
      () => {
        const sels = document.querySelectorAll('select[aria-hidden="true"]');
        return sels.length === 0 || [...sels].every((s) => s.options.length > 1);
      },
      { timeout: 4000 },
    ).catch(() => {});
    // 폼을 외부 SaaS iframe 으로 심는 사이트가 있다 (리스페이스 → ReCatch). 프레임 로딩을 더 기다린다.
    if (page.frames().length > 1) await page.waitForTimeout(3000);

    const best = await pickBestContext(page, target);
    if (best.captcha) {
      return {
        ...base,
        status: "skipped",
        unresolved: [
          { reason: "captcha", detail: `캡차 감지 — 자동 우회하지 않는다. 수동 처리 필요: ${best.captcha.hints.join(", ") || "grecaptcha/turnstile 전역객체"}` },
        ],
      };
    }
    if (!best.ctx) {
      return { ...base, status: "skipped", unresolved: [{ reason: "not-found", detail: "입력 가능한 폼을 못 찾았다" }] };
    }

    const { ctx, plan, unresolved, warnings, group } = best;
    base.form =
      (group ? `#${group.id} ${group.desc}${group.heading ? ` "${group.heading}"` : ""}` : "") +
      (ctx === page.mainFrame() ? "" : ` [iframe: ${new URL(ctx.url()).host}]`);

    if (unresolved.length) {
      return { ...base, status: "skipped", unresolved, warnings, mapped: plan.map(planLabel) };
    }

    const applied = await applyPlan(ctx, plan);
    const failedSteps = applied.filter((a) => !a.ok);
    const mismatches = await verifyPlan(ctx, plan);

    /**
     * 체크박스 토글 경로를 알려준다.
     * 실제 클릭 계열(playwright-click / label 클릭)은 프레임워크가 정상 인지하므로 조용히 넘기고,
     * force·DOM click 처럼 우회 성격이 있는 경로만 경고한다 (제출 시 상태 반영 확인 필요).
     */
    const SAFE_TOGGLE = ["playwright-click", "label-for-click", "ancestor-label-click", "이미 원하는 상태"];
    for (const a of applied) {
      if (a.ok && a.method && !SAFE_TOGGLE.includes(a.method))
        warnings.push(`${a.key} 체크박스를 "${a.method}" 우회 경로로 토글 — 제출 시 반영되는지 확인 필요`);
    }

    const beforeShot = await shoot(page, url, "before");
    base.shots.push(beforeShot);

    if (failedSteps.length || mismatches.length) {
      return {
        ...base,
        status: "failed",
        mapped: plan.map(planLabel),
        warnings,
        unresolved: [
          ...failedSteps.map((f) => ({ reason: "apply-failed", detail: `${f.key}: ${f.error}` })),
          ...mismatches.map((m) => ({ reason: "verify-mismatch", detail: `${m.key}: 기대 "${m.expected}" / 실제 "${m.got}"` })),
        ],
      };
    }

    if (!OPTS.submit) {
      return {
        ...base,
        status: "dry",
        mapped: plan.map(planLabel),
        warnings,
        submitSelector: group?.submit?.selector ?? null,
        submitText: group?.submit?.text ?? null,
      };
    }

    /* ── 여기부터 실제 전송 (--submit 전용) ── */

    if (!group?.submit) {
      return { ...base, status: "failed", mapped: plan.map(planLabel), warnings, unresolved: [{ reason: "no-submit-button", detail: "제출 버튼을 못 찾았다" }] };
    }

    const urlBefore = page.url();
    const respPromise = page
      .waitForResponse((r) => r.request().method() === "POST" && r.request().resourceType() !== "image", { timeout: 15000 })
      .catch(() => null);
    await ctx.locator(group.submit.selector).first().click();
    const resp = await respPromise;
    await page.waitForTimeout(2500);

    const afterShot = await shoot(page, url, "after");
    base.shots.push(afterShot);

    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    const successText = /완료|접수|감사|정상적으로|성공|submitted|thank/i.test(bodyText);
    const urlChanged = page.url() !== urlBefore;
    const httpOk = resp ? resp.status() >= 200 && resp.status() < 300 : false;

    return {
      ...base,
      status: httpOk || successText || urlChanged ? "sent" : "failed",
      mapped: plan.map(planLabel),
      warnings,
      http: resp ? `${resp.status()} ${resp.url()}` : "(POST 응답 미포착)",
      evidence: { httpOk, successText, urlChanged },
    };
  } catch (e) {
    return { ...base, status: "failed", unresolved: [{ reason: "exception", detail: e.message.split("\n")[0] }] };
  } finally {
    if (!OPTS.headless && !OPTS.submit) await page.waitForTimeout(4000); // 사람이 눈으로 볼 시간
    await ctx.close();
  }
}

/* ─────────────────────────── 프레임 선택 ─────────────────────────── */

/**
 * 메인 프레임과 모든 자식 iframe 을 각각 조사해 문의폼이 있는 곳을 고른다.
 * 폼을 외부 SaaS iframe 으로 심는 사이트가 있다 (리스페이스 → ReCatch).
 * 선택 기준: 미해결 0 인 곳 우선, 그다음 매핑된 필드 수가 많은 곳.
 */
async function pickBestContext(page, target) {
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())].filter(
    (f) => !f.url().startsWith("about:"),
  );

  let best = null;
  let captcha = null;

  for (const ctx of frames) {
    let inventory;
    try {
      inventory = await inspectForm(ctx);
    } catch {
      continue; // 접근 불가·소멸한 프레임
    }
    if (inventory.captcha.detected && !captcha) captcha = inventory.captcha;
    if (!inventory.fields.length) continue;

    const m = mapFields(inventory, profile, target);
    const score = (m.unresolved.length === 0 && m.plan.length ? 1000 : 0) + m.plan.length;
    if (!best || score > best.score) best = { ctx, inventory, score, ...m };
  }

  // 캡차는 폼을 찾은 프레임에서만 문제 삼는다 (메인 페이지의 무관한 캡차로 스킵되면 손해)
  if (best && !best.inventory.captcha.detected) captcha = null;
  return { ...(best ?? { ctx: null, plan: [], unresolved: [], warnings: [] }), captcha };
}

/* ─────────────────────────── 헬퍼 ─────────────────────────── */

function readJson(p) {
  if (!fs.existsSync(p)) {
    console.error(`설정 파일이 없다: ${p}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function planLabel(p) {
  const v = typeof p.value === "boolean" ? (p.value ? "체크" : "해제") : String(p.value).replace(/\s+/g, " ").slice(0, 30);
  return `${p.key}=${v} → ${p.field}`;
}

async function shoot(page, url, tag) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const host = new URL(url).host.replace(/[^\w.-]/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(SHOTS, `${host}-${stamp}-${tag}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function loadSentUrls() {
  if (!fs.existsSync(LOG)) return new Set();
  const rows = fs.readFileSync(LOG, "utf8").split("\n").slice(1);
  return new Set(
    rows
      .map((l) => l.split(",").map(unq))
      .filter((c) => c[2] === "sent")
      .map((c) => c[1]),
  );
}

function appendLog(r) {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, "ts,url,status,mapped,unresolved,http,shots\n");
  const row = [
    r.ts,
    r.url,
    r.status,
    r.mapped.join(" | "),
    r.unresolved.map((u) => `${u.reason}: ${u.detail}`).join(" | "),
    r.http,
    r.shots.join(" | "),
  ]
    .map(q)
    .join(",");
  fs.appendFileSync(LOG, row + "\n");
}

// 함수 선언으로 둔다 — 실행 블록이 파일 상단에 있어 const 화살표면 TDZ 에 걸린다
function q(s) {
  return `"${String(s ?? "").replace(/"/g, '""')}"`;
}
function unq(s) {
  return String(s ?? "")
    .replace(/^"|"$/g, "")
    .replace(/""/g, '"');
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 팝업 자동 닫기.
 * 공통 닫기 버튼 패턴을 순서대로 시도하고, extraText 가 있으면 그 텍스트도 추가로 클릭한다.
 * 실패해도 폼 탐색을 계속한다 (경고만 남김).
 */
async function dismissPopups(page, extraText) {
  const CLOSE_TEXT = /^(×|✕|✖|X|x|닫기|확인|close|dismiss|나중에|오늘 하루|일주일|광고 닫기)$/i;
  const CLOSE_SEL = [
    '[class*="close"]',
    '[class*="popup-close"]',
    '[class*="modal-close"]',
    '[aria-label*="close" i]',
    '[aria-label*="닫기"]',
  ].join(", ");

  // 1) 공통 텍스트 패턴
  try {
    const btns = await page.locator(`button, a, [role="button"]`).all();
    for (const btn of btns) {
      const txt = (await btn.innerText().catch(() => "")).trim();
      if (CLOSE_TEXT.test(txt) && await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    }
  } catch { /* 팝업 없으면 그냥 통과 */ }

  // 2) 공통 셀렉터 패턴
  try {
    const els = await page.locator(CLOSE_SEL).all();
    for (const el of els) {
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    }
  } catch { /* 없으면 통과 */ }

  // 3) targets.json 에서 명시한 텍스트
  if (extraText) {
    await page.getByText(extraText, { exact: false }).first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

function printHuman(r) {
  const icon = { dry: "🟡", sent: "🟢", skipped: "⬜", failed: "🔴" }[r.status] ?? "?";
  console.log(`\n${icon} ${r.status.toUpperCase()}  ${r.url}`);
  if (r.form) console.log(`   폼 ${r.form}`);
  for (const m of r.mapped) console.log(`   ✓ ${m}`);
  for (const w of r.warnings) console.log(`   ⚠ ${w}`);
  for (const u of r.unresolved) console.log(`   ✗ [${u.reason}] ${u.detail}`);
  if (r.http) console.log(`   HTTP ${r.http}`);
  for (const s of r.shots) console.log(`   📷 ${s}`);
  if (r.status === "dry") console.log(`   → 실제 전송은 --submit 을 붙여라 (제출버튼: ${r.submitText ?? "미탐지"})`);
}
