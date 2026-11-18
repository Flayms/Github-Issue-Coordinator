/**
 * `bun run check:pipeline-hover`: REQ-003-02 in a real browser (#121). Hovers every issue in the
 * Pipeline of the mock Overview at 1280 px and fails if a hover makes the Pipeline wider than its
 * box (`scrollWidth` > `clientWidth`, i.e. a horizontal scrollbar), then checks that at 390 px the
 * columns still scroll sideways. Needs Chrome or Chromium (`$CHROME` to pick one), like
 * `bun run screenshots`, so it is not part of `bun test`.
 *
 * It must not pass for the wrong reason (docs/known-pitfalls.md): headless Chrome reports
 * `hover: none`, so Chrome is started with a hover-capable pointer; and a page in the background
 * doesn't run its transitions, so the page is brought to the front and each card is measured only
 * once its nudge has ended (`transitionend`). A card that isn't `:hover`ed or never nudges fails.
 */
import { type Cdp, openMockBrowser } from "./dashboard-screenshots.ts";

const HOVER_POINTER =
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4";
const GRID = "document.querySelector('#pipeline .grid')";
/** How long a card's nudge (450 ms) may take before the check gives up on it. */
const NUDGE_TIMEOUT_MS = 3000;

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.text}`);
  return r.result.value;
}

async function open(cdp: Cdp, base: string, width: number) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: `${base}/` });
  await loaded;
  await evaluate(cdp, "document.fonts.ready.then(() => true)");
}

const widths = (cdp: Cdp) => evaluate<[number, number]>(cdp, `[${GRID}.scrollWidth, ${GRID}.clientWidth]`);

/** One line per problem; empty when hovering never widens the Pipeline and a phone can still swipe. */
export async function checkPipelineHover(): Promise<string[]> {
  const problems: string[] = [];
  const { cdp, base, close } = await openMockBrowser([HOVER_POINTER]);
  try {
    await cdp.send("Page.bringToFront");
    await open(cdp, base, 1280);
    if (!(await evaluate<boolean>(cdp, "matchMedia('(hover: hover)').matches")))
      return ["the browser reports hover: none, so hover styles cannot be checked"];
    const [scroll, client] = await widths(cdp);
    if (scroll > client) problems.push(`1280 px, no hover: the Pipeline already scrolls (${scroll} > ${client})`);
    const cards = await evaluate<number>(cdp, `${GRID}.querySelectorAll('li').length`);
    if (cards === 0) return ["the mock Pipeline has no issues to hover"];

    for (let n = 0; n < cards; n++) {
      const card = `${GRID}.querySelectorAll('li')[${n}]`;
      const [x, y, label] = await evaluate<[number, number, string]>(
        cdp,
        `(() => { const li = ${card}; li.scrollIntoView({ block: "center", behavior: "instant" });
          const r = li.getBoundingClientRect();
          return [r.x + r.width / 2, r.y + r.height / 2, li.querySelector(".font-mono")?.textContent ?? "card ${n + 1}"]; })()`,
      );
      const nudged = evaluate<boolean>(
        cdp,
        `new Promise((done) => {
          ${card}.firstElementChild.addEventListener("transitionend", () => done(true), { once: true });
          setTimeout(() => done(false), ${NUDGE_TIMEOUT_MS}); })`,
      );
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      if (!(await nudged)) {
        problems.push(`1280 px, ${label}: the card did not nudge on hover, so nothing was measured`);
        continue;
      }
      const hovered = await evaluate<boolean>(cdp, `${card}.matches(":hover")`);
      const [hScroll, hClient] = await widths(cdp);
      if (!hovered) problems.push(`1280 px, ${label}: the mouse did not hover the card`);
      else if (hScroll > hClient)
        problems.push(`1280 px, ${label} hovered: the Pipeline scrolls sideways (${hScroll} > ${hClient})`);
    }

    await open(cdp, base, 390);
    const [pScroll, pClient] = await widths(cdp);
    if (pScroll <= pClient) problems.push(`390 px: the columns no longer scroll sideways (${pScroll} <= ${pClient})`);
    return problems;
  } finally {
    await close();
  }
}

if (import.meta.main) {
  const problems = await checkPipelineHover();
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length) process.exit(1);
  console.log("✓ hovering any Pipeline issue keeps its width at 1280 px; it still scrolls sideways at 390 px");
}
