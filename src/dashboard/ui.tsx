/**
 * Shared React components of the dashboard (spec 003): the page frame with its header, and small
 * building blocks. Rendered to static HTML on the server (REQ-003-19); React escapes every value,
 * since titles and names come from GitHub and agents (REQ-003-09). No `style` props: the CSP allows
 * only the same-origin stylesheet, so all styling is Tailwind classes (see docs/known-pitfalls.md).
 */
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assetUrl } from "./assets.ts";
import type { DashboardView, Tone } from "./view.ts";

/** Line icons (24×24, stroked), drawn inline so they need no request and no container. */
const ICONS = {
  logo: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  lock: "M7 11V8a5 5 0 0110 0v3M5 11h14v10H5z",
  merge: "M6 3v12M6 21a3 3 0 100-6 3 3 0 000 6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9",
  check: "M5 12.5l4.5 4.5L19 7",
  cross: "M6 6l12 12M18 6L6 18",
  dot: "M12 12h.01",
  clock: "M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  alert: "M12 4l9 16H3l9-16zM12 10v4M12 17.5h.01",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  bolt: "M13 3L5 13h6l-1 8 8-10h-6l1-8z",
  pause: "M8 5v14M16 5v14",
  phone: "M8 2h8a1 1 0 011 1v18a1 1 0 01-1 1H8a1 1 0 01-1-1V3a1 1 0 011-1zM11 18h2",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  repo: "M5 4h11l3 3v13H5zM9 4v6l2-1.5L13 10V4",
  doc: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  pr: "M6 3v12M6 21a3 3 0 100-6 3 3 0 000 6zM18 21a3 3 0 100-6 3 3 0 000 6zM18 15V8a3 3 0 00-3-3h-4M13 3l-2 2 2 2",
  loop: "M4 12a8 8 0 0114-5.3M20 4v4h-4M20 12a8 8 0 01-14 5.3M4 20v-4h4",
  compass: "M12 21a9 9 0 100-18 9 9 0 000 18zM15.5 8.5l-2 5-5 2 2-5z",
  code: "M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
  hourglass: "M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9",
  arrow: "M7 17L17 7M9 7h8v8",
} as const;
export type IconName = keyof typeof ICONS;

/** An icon, 16px unless `className` sizes it otherwise. */
export function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`inline-block shrink-0 align-[-3px] ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/** The colour of each tone's dot (REQ-003-17: the tone marks a dot or an icon, the text stays neutral). */
export const TONE_BG: Record<Tone, string> = {
  acc: "bg-acc-hi",
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  muted: "bg-muted",
};

/** The text colour of each tone (see `Tone`). */
export const TONE_TEXT: Record<Tone, string> = {
  acc: "text-acc-hi",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  muted: "text-muted",
};

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const Empty = ({ children, className = "" }: { children: string; className?: string }) => (
  <p className={`my-1.5 text-[13px] text-faint ${className}`}>{children}</p>
);

/** A link to another site (GitHub, claude.ai): opens in a new tab and sends no referrer (REQ-003-45). */
export const Link = ({ href, className, children }: { href: string; className?: string; children: ReactNode }) => (
  <a className={className} href={href} target="_blank" rel="noopener noreferrer">
    {children}
  </a>
);

/** A section heading in the mockup's style: the title and a quiet note next to it. */
export const Heading = ({ title, note }: { title: string; note: string }) => (
  <h2 className="mb-[18px] flex items-baseline gap-3 font-bold text-[20px] text-white leading-tight">
    {title} <span className="font-sans font-semibold text-[12px] text-white/45 tracking-[0.02em]">{note}</span>
  </h2>
);

/** A small heading in capitals, as on the Config page and over Capacity; 12px below unless `className` says otherwise. */
export const Label = ({ children, className = "mb-3" }: { children: ReactNode; className?: string }) => (
  <h2
    className={`flex items-center gap-2 font-semibold text-[13px] text-muted uppercase tracking-[0.12em] ${className}`}
  >
    {children}
  </h2>
);

/** A number in a pill, e.g. the issues in a Pipeline column. */
export const Count = ({ children }: { children: ReactNode }) => (
  <span className="rounded-full border border-line-2 px-[7px] py-[3px] font-medium font-mono text-[11px] text-muted leading-none tracking-normal">
    {children}
  </span>
);

const Tab = ({ href, current, children }: { href: string; current: boolean; children: string }) => (
  <a
    href={href}
    aria-current={current ? "page" : undefined}
    className={`rounded-full px-3.5 py-[5px] max-sm:px-2.5 font-medium text-[13px] transition-colors ${
      current ? "bg-acc/22 text-white" : "text-muted"
    }`}
  >
    {children}
  </a>
);

/** The countdown ring next to the refresh time; the script moves it (REQ-003-06). */
const Ring = () => (
  <svg className="size-[18px] -rotate-90" viewBox="0 0 20 20" aria-hidden="true">
    <circle className="ring-bg" cx="10" cy="10" r="8" />
    <circle className="ring-fg" cx="10" cy="10" r="8" strokeDasharray="50.27" strokeDashoffset="0" />
  </svg>
);

const TITLES = { overview: "Coordinator", config: "Config · Coordinator", timings: "Timings · Coordinator" };

/**
 * The page frame shared by the pages: header with tabs, countdown and alerts. While `editing` (the Config form,
 * REQ-003-36) the page doesn't refresh itself, so entered values and a save's errors stay.
 */
export function Layout({
  v,
  page,
  editing = false,
  children,
}: {
  v: DashboardView;
  page: keyof typeof TITLES;
  editing?: boolean;
  children: ReactNode;
}) {
  // REQ-003-17: a failed poll is red, the usage-limit pause only waits; the text stays neutral.
  const alerts: { icon: IconName; tone: Tone; text: string }[] = [
    ...(v.pausedUntil
      ? [
          {
            icon: "pause" as const,
            tone: "muted" as const,
            text: `Usage limit: new work pauses until ${v.pausedUntil}.`,
          },
        ]
      : []),
    ...v.errors.map((e) => ({
      icon: "alert" as const,
      tone: "bad" as const,
      text: `${e.repo}: polling failed: ${e.error}`,
    })),
  ];
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        {!editing && (
          <noscript>
            <meta httpEquiv="refresh" content={String(v.refreshSec)} />
          </noscript>
        )}
        <meta name="referrer" content="no-referrer" />
        <meta name="color-scheme" content="dark" />
        <meta name="theme-color" content="#05060B" />
        <title>{TITLES[page]}</title>
        <link rel="stylesheet" href={assetUrl("dashboard.css")} />
        <script src={assetUrl("dashboard.js")} defer />
        <script src={assetUrl("meters.js")} defer />
      </head>
      {/* A column, so the Overview's band can grow to the bottom of a short page (#100). */}
      <body className="flex flex-col">
        {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a canvas without tabindex is not focusable; the background is decoration */}
        <canvas id="bg" aria-hidden="true" />
        {/* REQ-003-39: a frosted bar pinned to the top; one row on a phone, its content in the page column. */}
        <header className="topbar">
          <div className="wrap flex h-[55px] items-center gap-2 sm:h-[58px] sm:gap-5">
            <a
              className="flex shrink-0 items-center gap-2 font-bold font-display text-[16px] text-fg leading-none"
              href="/"
              aria-label="Coordinator"
            >
              <Icon name="logo" className="size-[22px] text-acc" />
              <span className="max-sm:hidden">Coordinator</span>
            </a>
            <nav className="flex shrink-0 gap-1 rounded-full border border-line bg-white/2 p-[3px]" aria-label="Pages">
              <Tab href="/" current={page === "overview"}>
                Overview
              </Tab>
              <Tab href="/config" current={page === "config"}>
                Config
              </Tab>
              <Tab href="/timings" current={page === "timings"}>
                Timings
              </Tab>
            </nav>
            <div className="ml-auto flex items-center gap-2 text-[12px] text-muted sm:gap-3.5">
              {editing ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border border-line-2 px-[9px] py-[3px]"
                  title="No refresh while you edit"
                >
                  <Icon name="pause" />
                  <span className="max-sm:hidden">No refresh while you edit</span>
                </span>
              ) : (
                <>
                  <span
                    className="inline-flex items-center gap-1.5"
                    data-reload={v.refreshSec}
                    title={`${v.lastTick ? `Last tick ${v.lastTick.at}` : "No tick has finished yet"} · refreshes every ${v.refreshSec} s`}
                  >
                    <Ring />
                    <span className="min-w-[4ch] font-mono max-[379px]:hidden" data-countdown="">
                      every {v.refreshSec} s
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-line-2 px-[9px] py-[3px] max-sm:hidden">
                    <Icon name="lock" />
                    Read-only
                  </span>
                </>
              )}
              {/* REQ-003-31: a plain form, so it works without JavaScript; the server answers with a signed-out page. */}
              {v.settings.access?.githubLogin === "on" && (
                <form method="post" action="/auth/logout">
                  <button
                    type="submit"
                    aria-label="Sign out"
                    title="Sign out"
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line-2 px-[9px] py-[3px] text-muted hover:border-acc hover:text-fg max-sm:py-[5px]"
                  >
                    <Icon name="user" />
                    <span className="max-sm:hidden">Sign out</span>
                  </button>
                </form>
              )}
            </div>
          </div>
        </header>
        <div className="wrap">
          {alerts.length > 0 && (
            <ul className="mt-3">
              {alerts.map((a) => (
                <li
                  key={a.text}
                  className="flex items-start gap-2 border-line-2 border-t py-2.5 text-fg wrap-anywhere last:border-b"
                >
                  <Icon name={a.icon} className={`size-4 ${TONE_TEXT[a.tone]}`} />
                  <span>{a.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {children}
      </body>
    </html>
  );
}

/** The note at the bottom of each page; the Overview puts it inside its band (#100). */
export const Footer = ({ className = "mt-12 pt-5", editing = false }: { className?: string; editing?: boolean }) => (
  <footer className={`wrap pb-8 text-[12px] text-faint ${className}`}>
    {editing
      ? "Only these settings change here. Approve, give feedback and merge on GitHub."
      : "Read-only: this page changes nothing. Approve, give feedback and merge on GitHub."}
  </footer>
);

/** A whole page as HTML. */
export const renderPage = (page: ReactElement): string => `<!doctype html>\n${renderToStaticMarkup(page)}\n`;
