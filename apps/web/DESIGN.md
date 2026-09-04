---
name: Agent Flow Dashboard
description: One dark plane with a run's evidence laid on it, read beside a terminal.
colors:
  bg: "#070b14"
  surface: "#0b111c"
  surface-2: "#0f1622"
  surface-3: "#151d2b"
  sunken: "#04070d"
  border: "rgba(148, 163, 184, 0.3)"
  border-strong: "rgba(148, 163, 184, 0.45)"
  text: "#f1f5f9"
  muted: "#a3b0c2"
  faint: "#7d8b9f"
  primary: "#7c3aed"
  primary-bright: "#9366f5"
  primary-soft: "rgba(124, 58, 237, 0.16)"
  primary-border: "rgba(147, 102, 245, 0.45)"
  success: "#34d399"
  success-soft: "rgba(52, 211, 153, 0.12)"
  info: "#3b82f6"
  info-soft: "rgba(59, 130, 246, 0.12)"
  warning: "#fbbf24"
  warning-soft: "rgba(251, 191, 36, 0.12)"
  danger: "#f87171"
  danger-soft: "rgba(248, 113, 113, 0.12)"
typography:
  hero:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: "32px"
    letterSpacing: "-0.025em"
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: "24px"
  section:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "22px"
  metric:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: "24px"
  body-lg:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    lineHeight: "20px"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    lineHeight: "18px"
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "12px"
    lineHeight: "16px"
  micro:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "11px"
    lineHeight: "14px"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
  glass-bg: "rgba(11, 17, 28, 0.72)"
  glass-border: "rgba(148, 163, 184, 0.12)"
  ambient-1: "rgba(124, 58, 237, 0.045)"
  ambient-2: "rgba(59, 130, 246, 0.03)"
rounded:
  focus: "4px"
  sm: "8px"
  md: "10px"
  lg: "12px"
shadows:
  sm: "0 1px 3px rgba(0, 0, 0, 0.4)"
  md: "0 4px 12px rgba(0, 0, 0, 0.5)"
  lg: "0 8px 28px rgba(0, 0, 0, 0.6)"
  glow: "0 0 40px rgba(124, 58, 237, 0.12)"
  glow-primary: "0 0 24px rgba(124, 58, 237, 0.35)"
glass:
  blur: "20px"
spacing:
  sidebar: "216px"
  topbar: "44px"
  inspector: "448px"
  page: "18px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "28px"
    padding: "0 10px"
  button-primary-hover:
    backgroundColor: "{colors.primary-bright}"
  button-surface:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "28px"
    padding: "0 10px"
  button-surface-hover:
    backgroundColor: "{colors.surface-3}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "28px"
    padding: "0 10px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
  button-sm:
    typography: "{typography.micro}"
    height: "24px"
    padding: "0 8px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "12px"
  badge:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.muted}"
    typography: "{typography.micro}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
  input-search:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
  select:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "24px"
    padding: "0 6px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "6px 8px"
  nav-item-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
  nav-item-active:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
  tooltip:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text}"
    typography: "{typography.micro}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    width: "min(560px, 92vw)"
  run-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.body-lg}"
    padding: "8px 10px"
  run-tab-active:
    textColor: "{colors.text}"
    borderBottomColor: "{colors.primary-bright}"
    borderBottomWidth: "2px"
  dag-node:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    width: "200px"
    height: "64px"
    padding: "6px 8px"
  terminal:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.muted}"
    typography: "{typography.mono}"
    padding: "14px"
---

# Design System: Agent Flow Dashboard

## Overview

**Creative North Star: "One Dark Plane"**

There is one plane, and information rests on it. That is the whole thesis, and
every other decision in this system is downstream of it. The page ground is a
blue-cast near-black; the three surfaces above it are separated by three or four
points of lightness — close enough that no bordered element also reads as a
lighter rectangle. Regions are told apart by a hairline and by what they mean,
never by brightness. An earlier pass put six points between the ground and the
first surface, and with a border on everything, the result was a tiled grid of
same-weight boxes. That grid is the anti-reference this system was built against.

The plane is dark by necessity, not by taste. This surface sits open beside a
terminal for hours while agent processes write to the repository, and it must not
be the brightest rectangle on the desk. Density follows from the same scene: the
base body size is 13px, buttons are 24 and 28px tall, and the type scale runs
from 11px to 24px in eight steps. Every measurement in the token file carries a
written reason — the inspector is 448px because the table needs the rest, the
pipeline chip floors at 132px because that is what "Implementation" needs beside
its marker at 12px. Nothing here is a default that survived by accident.

Restraint is the mechanism, and one accent is the exception that proves it.
Orchestration Violet appears on exactly two things: the pipeline step that is
running, and the navigation destination you are on. A running *task* is blue
specifically so that violet keeps meaning "where is this run right now". Rejected
outright: light or high-contrast grounds, marketing-dashboard chrome (gradients,
glass, illustrated empty states, floating shadowed cards), colour as the only
carrier of status, and any return to the equal-weight box grid.

**Key Characteristics:**

- One dark plane; four surfaces within three points of lightness of each other
- Hairline borders at 10% alpha carry all structure — 20% only on hover or emphasis
- Flat at rest: nothing on the page casts a shadow
- Exactly one surface goes *below* the plane, and only the terminal uses it
- One violet, spent on two things
- Status always arrives as ring + glyph + word, never hue alone
- Eight-step type scale, 11px to 24px, tabular numerals wherever a number ticks
- Every dimension is a token, and every token has a written justification

## Colors

A near-monochrome blue-black field with one violet accent and four semantic
signal hues that are never used decoratively.

### Primary

- **Orchestration Violet** (`{colors.primary}`): The running pipeline step and
  the active navigation destination. Nothing else. Full-strength violet is a
  surface fill in exactly those two places, which is what makes it findable
  without reading.
- **Violet Bright** (`{colors.primary-bright}`): Primary button hover, the
  selected DAG node's border and ring, and the focus ring's sibling. The lift
  that says a violet element responded.
- **Violet Soft** (`{colors.primary-soft}`): The 16%-alpha wash behind the
  running pipeline chip, the selected project row, and the local-mode avatar.
  Presence without a second full-strength violet on screen.
- **Violet Border** (`{colors.primary-border}`): The 45%-alpha ring on
  violet-toned elements and on DAG nodes related to the selection by dependency.

### Secondary

Four semantic signal colours. They are mapped from real status by a single
module and are never chosen per screen, never used as brand colour, and never
used for decoration.

- **Signal Green** (`{colors.success}`) + **Green Wash**
  (`{colors.success-soft}`): Completed stages and tasks, overall run progress,
  and the live event stream. Progress is green because progress is a quantity,
  not a status.
- **Signal Blue** (`{colors.info}`) + **Blue Wash** (`{colors.info-soft}`): A
  *task* that is running, and an approved run. Deliberately not violet.
- **Signal Amber** (`{colors.warning}`) + **Amber Wash**
  (`{colors.warning-soft}`): Blocked, review-required, interrupted, waiting for
  approval, degraded stream, unavailable runner.
- **Signal Red** (`{colors.danger}`) + **Red Wash** (`{colors.danger-soft}`):
  Failed, rejected, and every refusal notice.

### Neutral

- **Ink Plane** (`{colors.bg}`): The page ground, and the ground the DAG canvas
  paints itself with so the graph is on the page rather than in a window.
- **Plane One / Two / Three** (`{colors.surface}`, `{colors.surface-2}`,
  `{colors.surface-3}`): Panels and cards; then inputs, secondary buttons and
  the footer block; then hover states, tooltips, progress tracks and muted
  badges. The steps between them are tiny on purpose.
- **Log Well** (`{colors.sunken}`): The only surface darker than the page.
  Terminal output and prompt bodies, and nothing else — which is exactly why it
  reads as a different kind of thing instead of one more panel.
- **Hairline** (`{colors.border}`) and **Hairline Strong**
  (`{colors.border-strong}`): All structure. Slate at 10% alpha, lifted to 20%
  on hover, on emphasis, and on anything that floats. At 14% every box shouted.
- **Text** (`{colors.text}`): Primary reading colour and every value a person
  needs.
- **Muted** (`{colors.muted}`): Secondary prose, inactive navigation, log
  bodies. Lifted from a darker slate because on this ground a metadata row at
  the old value became decoration.
- **Faint** (`{colors.faint}`): Field labels, captions, breadcrumb ancestors,
  disabled affordances, and the "nothing here yet" line.

### Named Rules

**The One Violet Rule.** Full-strength violet marks the running pipeline step
and the active nav destination. A running task is blue. If violet ever marks a
third kind of thing, it stops answering "where is this run right now" and the
system loses its only loud voice.

**The No Loose Colour Rule.** A colour is written down once, in `tokens.css`.
Tailwind's palette is generated from it, so `bg-surface` cannot resolve to a
shade the token file does not define, and retuning the whole surface is one file.
A component never receives a colour — it receives a *tone*, and one module turns
a status into a tone.

**The Three-Channel Status Rule.** Status is ring, glyph, and word. A greyscale
screenshot, a colour-blind reader, and a glance from three feet away all have to
get the same answer, so hue is never load-bearing on its own.

## Typography

**Display / Body Font:** the platform's own UI face — `system-ui`, with
`-apple-system`, `Segoe UI` and `sans-serif` behind it. No webfont is loaded, and
none should be added without re-measuring the layout (see the rule below).
**Mono Font:** `ui-monospace`, `SFMono-Regular`, `Menlo`, `monospace`.

**Character:** The host operating system's own voice, doing all the talking at
small sizes, with weight and size — not colour — carrying the hierarchy. The
effect is intentional for a local developer tool: the dashboard reads as part of
the machine it runs on rather than as a web page visiting it. Mono is not a
stylistic alternate; it is a marker meaning "a machine emitted this".

### Hierarchy

- **Hero** (700, 24px/30px, -0.025em): The run id, and the largest type on any
  screen. Bold *and* large, so it holds the header alone.
- **Title** (400, 17px/24px): The feature name, beside the run id rather than
  under it. Regular weight on purpose — matching the run id's weight produced two
  competing headlines on one line — but full text colour, because secondary is
  not the same as dim.
- **Section** (600, 15px/22px): Panel and dialog headings.
- **Metric** (600, 18px/24px, tabular): The numbers in a count strip.
- **Body Large** (14px/20px): Card headings and the product wordmark (bold,
  uppercase, wide tracking).
- **Body** (13px/18px): The document base and table content.
- **Label** (12px/16px): The working size of this interface — buttons, table
  cells, nav items, chips, metadata values, form controls.
- **Micro** (11px/14px): Field labels, captions, badges, sub-lines, code
  fragments, column headers (uppercase, wide tracking).

### Named Rules

**The Tabular Rule.** Any number that changes in place carries
`font-variant-numeric: tabular-nums` — durations, percentages, counts, run ids.
A ticking duration that reflows its row is a layout bug wearing a number.

**The Mono-Is-Evidence Rule.** Mono is reserved for what a machine produced:
paths, hashes, error codes, config keys, commands, cycle chains, log bodies.
Prose never uses it, and a mono string is never asked to wrap prettily — it
scrolls.

**The Single Headline Rule.** One line may carry only one heavy string. Where two
pieces of information share a row, the second drops to regular weight and keeps
full colour.

**The System-Face Rule.** No webfont ships with this dashboard. Every pixel floor
in `tokens.css` was measured in the platform's own UI face — 132px is what
"Implementation" needs *there* — and both committed visual baseline sets are
pictures of it. Introducing a webfont is therefore not a typography change but a
re-calibration: it invalidates every baseline and every measured width at once. If
one is ever wanted, it is a milestone with re-measurement in it, not an edit to
the font stack.

## Layout

A fixed application frame, not a scrolling document. A 216px sidebar, a 44px
command bar, and 18px of page padding — all tokens, so the layout and the design
system cannot drift apart. The frame never scrolls; individual panes do.

**One surface at a time (M8.5).** A run page draws a one-row header, an attention
strip when there is one, a tab strip, and then the chosen surface filling
everything left. It used to draw all of them at once: measured at 1440×900, the
document ran to 1753px for a 900px viewport and the board held 555. The header
rows are `flex-shrink: 0` and the surface is `flex: 1; min-height: 0`, so the
board grows into the viewport rather than the page growing past it.

Vertical rhythm inside panels is Tailwind's 4px scale: 12px/16px panel padding,
gaps of 4, 6, 8 and 12px. Metrics live in a hairline-divided horizontal strip
inside a panel header — never in bordered metric cards. That single change
replaced five boxes with a strip at a fifth of the height, and the table got the
difference.

Two custom breakpoints, both measured rather than inherited:

- **`pane` (1200px)** — where the task inspector stops sharing a row and becomes
  a right-hand drawer. The switch happens in JavaScript, not with `hidden`
  classes, because CSS visibility would leave both inspectors in the document and
  a screen reader would find two panels describing one task. **The board never
  shares the row at any width**: its lanes are 244px each and there are six, so a
  400px pane leaves two and a sliver — photographed at 1200 with `IN PROGRESS`
  sliced down its middle. A table reflows its own columns and a canvas refits its
  own viewport; a row of fixed-width columns cannot give one away.
- **`wide` (1440px)** — the full layout. Below it: the inspector narrows from
  448px to 400px, page padding from 18px to 14px, action labels collapse to icons
  with `sr-only` text, and the nine-step pipeline scrolls sideways instead of
  compressing.

Below **1024** the sidebar becomes a drawer, the board stacks its lanes, and the
tab strip puts its filter on a second row — one row at 390px pinned the five
status chips to the right edge and sliced them to `All`, `Ru`, `Wa`, `Co`, `Fai`
while the search box collapsed to a circle. The page-overflow check read zero the
whole time, because the damage was inside a flex child rather than past the
document edge.

Horizontal overflow is announced with edge gradients that fade to the *containing
surface*, driven by measurement, so a row that fits gets no fade at all. The
pipeline's fade is `from-surface` because it sits inside a `Panel`; the board's is
`from-bg` because it renders straight onto the page. Two gradients, two grounds,
and getting either wrong is invisible to every assertion and obvious in a
photograph. Custom scrollbars are furniture at every width; a fade appears only
where content is genuinely hidden.

### Named Rules

**The Table Wins Rule.** When width runs out, the inspector narrows first and the
padding tightens second. The table is the surface people read, and eight columns
in 530px is not a table.

**The Scroll-Don't-Shave Rule.** A row of labelled steps scrolls sideways before
it compresses. A stepper you can push is still a stepper; a stepper reading
"Architectu…" beside "Implemen…" is not readable at all.

**The Thirty-Second Rule (M8.5).** If an operator does not need a fact in the next
thirty seconds, it does not get permanent space on the main screen. It gets a tab.
The test of the rule is what is *absent*: a run page that shows the pipeline, the
task counts and four summary cards at the same time as the board has failed it,
whatever each of those looks like on its own.

**The Absent Door Rule (M8.5).** A tab whose projection has nothing behind it is
not rendered. Most runs have no reviewer and no forge; a permanently empty tab is
the same box on every dashboard forever, at 60 horizontal pixels instead of 200
vertical ones.

**The Empty Lane Rule (M8.5).** A container with nothing in it stops being drawn
as a container. An empty board lane keeps its name and its zero — dropping it
would change the board's width as a run progresses — and loses its border, its
fill and its card list. Three bordered 700px voids on a healthy run is half the
board rendering nothing, loudly.

## Elevation & Depth

Flat, tonal, and hairline-drawn. Nothing on the page casts a shadow. Depth is
communicated by four surface values within a few points of lightness of each
other plus a 10%-alpha border, and the border is doing most of the work. Shadows
exist only on things that genuinely float above the plane, and the DAG's imported
library shadows are explicitly zeroed out to keep it that way.

### Shadow Vocabulary

- **Floating panel** (`box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.25)`, Tailwind
  `shadow-2xl`, unmodified): Dialogs and the inspector drawer — the only elements
  that overlay the page. Paired with a `border-strong` hairline and a
  `rgb(0 0 0 / 0.7)` backdrop.
- **Transient overlay** (`box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px
  10px -6px rgb(0 0 0 / 0.1)`, Tailwind `shadow-xl`, unmodified): Tooltips.

### Named Rules

**The Flat-Plane Rule.** If it is part of the page, it has no shadow. A shadow is
a claim that something is above the plane, and only overlays get to make it.

**The One-Way-Down Rule.** Exactly one surface is darker than the page — the Log
Well — and only terminal output and prompt bodies use it. Its rarity is what
makes it read as a different kind of thing rather than another panel.

## Shapes

A tight, consistent radius family and almost no other form language. Corners are
6px on controls and chips, 8px on notices and DAG nodes, 10px on panels, cards
and dialogs — so a container is always slightly softer than the controls inside
it. Fully round is reserved for genuine circles: status rings, progress tracks
and fills, the wordmark dot, the local-mode avatar. The focus ring is the one
radius that ignores its host: 4px (`{rounded.focus}`) regardless of what it
surrounds, because it is drawn outside the element and belongs to the ring rather
than to the shape underneath.

Every boundary is a 1px hairline. There are no thick borders, no double rules, no
dividers heavier than 1px, and no decorative shapes at all — no blobs, no
gradient meshes, no illustrated empty states. Separation inside a panel is a
single hairline where the content needs it, and nowhere else. Table columns are
fixed-width and separated by nothing but alignment.

### Named Rules

**The Border-Not-Fill Rule.** Structure comes from a hairline, not from a
brightness step. Before adding a surface value to separate two regions, add a
border — and if a border does not solve it, the regions are probably one region.

## Components

Two container primitives, six controls, and three signature components. The set
is deliberately small: a single generic `Card` used everywhere is what produced
the equal-weight grid, so there are now *two* containers with different jobs and
no third.

Motion is minimal and functional, and the whole inventory is four things: colour
transitions on interactive elements, an opacity transition on a dimmed DAG node, a
width transition on progress, and a spinner on anything actually running. There
are no keyframes of our own, no easing tokens, no entrance animations, no chart
animation (both Recharts panels set `isAnimationActive={false}`), and the graph's
opening fit is instant rather than a pan.

All four are neutralised under `prefers-reduced-motion: reduce` by a single base
rule — see The Redundant-Motion Rule below.

### Named Rules

**The Redundant-Motion Rule.** Motion may reinforce a signal; it may never be the
signal. Every spinner in this app sits beside a word that does not move — "RUNNING"
in the table and the graph, "Running…" in the job pill, the stage's own status
under the pipeline chip — which is what makes stopping all of it under
`prefers-reduced-motion: reduce` safe rather than lossy. One base rule neutralises
every animation and transition in the app and in any library inside it, blunt on
purpose: a rule naming today's four would miss the fifth, and the fifth is the one
nobody remembers adding. If a new element needs motion to be understood, the
element is wrong, not the rule.

### Buttons

- **Shape:** Small radius (6px), 28px tall at default size, 24px at small.
- **Primary:** Violet fill with white text (`{components.button-primary}`),
  hovering to Violet Bright. Reserved for the affirmative action in a dialog or
  an action row.
- **Surface (default):** Plane Two fill with a hairline
  (`{components.button-surface}`); hover strengthens the border *and* lifts to
  Plane Three. This is the ordinary button of the interface.
- **Ghost:** No fill, muted text; hover lands on Plane Two and full text colour.
  For icon-scale controls inside dense rows.
- **Disabled:** 45% opacity plus `not-allowed`, never a colour change. A button
  that is disabled because the workflow refuses it carries a `title` saying why.
- **Toggle:** A button that turns something on and leaves it on carries
  `aria-pressed`. Colour is not a state.

### Cards / Containers

Two, and the difference between them is the hierarchy of the whole screen.

- **Panel** — a place where work happens. Plane One, 10px radius, hairline
  border, a flush 15px header inside the panel rather than a bar on top of it,
  and one optional hairline under the header. The run, the task table, the
  inspector.
- **Card** — a place where a number lives. Same border and radius, 14px header,
  12px padding, and an optional micro footer above a hairline. Quieter on
  purpose, so the bottom row reads as a footnote rather than as four more things
  competing with the table.
- Neither takes a colour. Both take a *tone*.

### Inputs / Fields

- **Search:** Hairline box on Plane Two, 6px radius, a faint 14px leading icon,
  faint placeholder, and no inner focus ring — the border strengthens via
  `focus-within` instead.
- **Select:** A native `<select>`, 24px tall on Plane Two, focus lit by a 1px
  Violet Bright ring. Deliberately not a custom listbox: keyboard driving,
  type-ahead, screen-reader announcement and the platform popover come free and
  cannot regress, and these are filters on a developer tool.
- **Textarea:** Log Well fill with a hairline, 8px radius — instruction and
  reason fields read as input surfaces, not as panels.
- **Focus, everywhere:** `2px solid` Orchestration Violet at `2px` offset,
  rounded 4px. The browser default outline disappears against this palette, and a
  dashboard driven from the keyboard where you cannot see where you are is not
  accessible in any useful sense.

### Navigation

Sidebar-first. The wordmark is a flat 24px violet square carrying `AF` beside
14px semibold text — flat rather than gradient, because a two-colour fill was the
only one in the app and read as a logo pasted onto a tool.

Nav items are 13px text at 6px/8px padding on an 8px radius: muted at rest, Plane
Two on hover, and **Plane Two with full text colour, medium weight, a violet icon
and a 2px violet rail at the left edge** when active. Route matching is exact, so
a list page does not stay lit while a detail page is open.

> This paragraph said "a full violet fill with white text" for two milestones and
> the stylesheet has always said `surface-2`. A design document that describes a
> treatment the app does not have is worse than one that describes nothing: the
> next person implements from it and produces a third answer.

**Seven destinations, one hairline, one heading (M8.5).** The list used to carry
`OPERATIONAL` and `SYSTEM` above its two halves — two headings naming categories
nobody navigates by, each costing a row and a rule the eye has to skip, on a list
short enough to read whole. A hairline says the same thing at no vertical cost.
`PROJECTS` stays, because it labels a genuinely different kind of row.

A destination with no page behind it stays in the list, visibly disabled, with a
title saying it is not implemented. A person cannot tell whether something
missing is missing or merely elsewhere.

Project rows are two lines — name, then current run and status — with a
status-toned dot. In a workspace of six repositories, a single line of name plus
coloured dot answers "which of these needs me" only by hovering each one in turn.

The footer carries one thing and it is the one thing that changes: whether a
runner is down. It used to carry a terminal avatar, `Agent Flow v0.1.0` and
`Local mode` beside a live dot — three constants — while the command bar carried
an `L` avatar whose tooltip also read "Local mode". A footer of constants is a
footer people stop looking at, and the runner warning goes with them.

The command bar is a context bar, not a page title: a 44px hairline strip carrying
a breadcrumb reading workspace / project / section / run, the stream indicator and
the docs link. It was a 16px-radius glass panel with a 40px blur, its own shadow
and a 24px gutter above it — 74 pixels and a second elevated surface competing
with the run header directly beneath.

### Run tabs (M8.5)

Seven surfaces of one run, as an underlined tab strip rather than pills. Seven
pills is seven bordered rectangles competing with each other and with everything
below them; an underline marks one and leaves the rest as text.

- **Rest:** 14px muted text, 10px/8px padding, no border and no fill.
- **Active:** full text colour, medium weight, and a 2px Violet Bright rule
  flush with the strip's own hairline. Inside the button and at `-bottom-px`, so
  the marker sits *on* the border rather than a pixel above it — a rule that
  misses by one reads as a rendering fault.
- **Roving tabindex:** one stop for the whole strip, arrows move within it and
  wrap. Seven tab stops would make the strip the longest thing on the page to
  walk past.
- **`aria-current="page"` as well as `aria-selected`**, because these tabs are
  also addresses: every one is linkable and bookmarkable.
- The filter sits at the right end of the strip as a *sibling* of the `tablist`,
  never inside it — a search box announced as one of seven tabs is a search box
  the arrow keys land on.

### Badges and Status Markers

- **Badge:** 6px radius, `1px 6px` padding, micro text, tonal wash background
  with tonal text. Uppercase and wide-tracked only when it carries a status word;
  badges also carry data, so caps are opt-in.
- **StatusDot:** A 14 or 16px ring with a 10px glyph and, unless suppressed, the
  status word beside it. Outlined by default; filled only when completed;
  spinning only when actually running. When the status is already stated visibly
  next to it, the marker is marked decorative and says nothing — otherwise a
  screen reader reads the same status twice.

### Signature: Stage Pipeline

The nine-stage stepper, and the reason the run panel reads as a flow rather than
a row of widgets. Each step is a chip — 8px radius, hairline border, status wash
— carrying a marker, a two-line-clamped label, and either a duration or its
status word underneath. Between chips sits an 8px hairline connector: everything
else here could be a widget, and the connector is what makes it a pipeline.

The running step is *wider* (flex 1.4 against 1), partly because it answers
"where is this run right now" and partly because "Implementation" is the longest
unbreakable word in the row. Chips floor at 132px and the row scrolls sideways
below 1440px with measured edge fades. Pending steps are transparent with muted
text; everything else takes its tonal wash.

### Signature: DAG Task Node

A fixed 200×64px box — declared, not measured, so five hundred nodes skip a
resize-observer round trip and the flash of unpositioned nodes that comes with
it. Plane One fill, 8px radius, and a border that carries three states: Violet
Bright with a ring when selected, Violet Border when related to the selection by
dependency, and the task's own status tone otherwise.

Inside: a decorative status marker, the task id in tabular micro, a tonal status
chip pushed right, the title at label size, and a 10px metadata line
(complexity · model · duration). That 10px is the one size in the app outside the
eight-step scale, and it exists because a 200px node could not hold micro across
three facts. A task nothing has executed says "no model yet" rather than showing
a zero.

Filtered-out and unrelated nodes drop to 30% opacity — dimmed, never removed. A
node that vanishes takes its edges with it, and a chain with a hole in the middle
describes a dependency that does not exist. Emphasis is carried by opacity and
border, never by a new colour.

### Signature: Live Indicator

A 28px hairline pill in the topbar with a 6px dot and a sentence, in three
states: Green wash reading "Agent Flow is running", Amber wash reading
"Reconnecting — polling", or a neutral Plane Two reading "Connecting…". The
sentence is the point — a coloured dot is not a status, and a stream that
silently died looks exactly like a run that is simply idle.

### Signature: Notice and Refusal

Not a toast. A tonal block — 8px radius, 25%-alpha tonal border, tonal wash —
placed beside the content it is about, carrying four things in order: what
happened, where (as mono evidence, indented), whether the workflow stopped, and
what to do next. `role="alert"` when it is a failure, `role="status"` otherwise.
The third field is the one that keeps getting dropped and the one that matters
most: "the plan review used the same provider" and "the run stopped" mean
entirely different things about whether anybody needs to act right now.

## Do's and Don'ts

### Do:

- **Do** add every colour to `tokens.css` and let Tailwind generate from it. One
  file retunes the whole surface.
- **Do** pass components a *tone* (`success` · `info` · `warning` · `danger` ·
  `primary` · `muted`) and let the single status module decide which one a status
  maps to.
- **Do** state status three ways — ring, glyph, word. Use the decorative marker
  variant when the word is already visible next to it.
- **Do** separate regions with a 1px hairline at 10% alpha, and reserve the 20%
  hairline for hover, emphasis, and floating surfaces.
- **Do** choose `Panel` for a region where work happens and `Card` for a region
  where a number lives. If the answer is "neither", it probably belongs inside an
  existing panel.
- **Do** put counts in a hairline-divided strip inside a panel header.
- **Do** mark every number that changes in place as tabular.
- **Do** reserve mono for machine output, and let long mono strings scroll.
- **Do** give the page-level dimensions names in `tokens.css` and write the
  reason for the value next to it, as every existing token does.
- **Do** derive control availability from real state, and give a disabled control
  a `title` that says why.
- **Do** keep exactly one of a duplicated pane in the document; use the media
  query hook, not `hidden` classes, when both copies would be announced.

### Don't:

- **Don't** write a colour, a radius, or a layout dimension inline in a
  component. Tailwind is mapped onto the tokens precisely so a component cannot
  invent a shade.
- **Don't** spend full-strength violet on a third kind of thing. The running
  pipeline step and the active nav destination are the whole budget; a running
  task is blue.
- **Don't** separate two surfaces by brightness when a hairline would do — six
  points of lightness between the ground and a surface is what produced the box
  grid this system was rebuilt to escape.
- **Don't** add a shadow to anything that is part of the page. Shadows belong to
  dialogs, drawers and tooltips only.
- **Don't** send anything other than terminal output or a prompt body to the Log
  Well. Its rarity is what makes it legible.
- **Don't** ship a light or high-contrast ground. This build is dark-only, the
  theme control is present-but-disabled and says so, and the palette exists
  because the tool sits beside a terminal.
- **Don't** bring marketing-dashboard chrome anywhere near this surface:
  gradients as decoration, glass, illustrated empty states, large decorative
  icons, floating shadowed cards.
- **Don't** convey state with colour alone — not in a badge, not in a dot, not in
  a toggle, not in a DAG node.
- **Don't** add a font size outside the eight-step scale. Two 10px sites exist and
  neither licenses a third: the DAG node's metadata line, justified by a 200px node
  holding three facts, and the React Flow attribution link, which is a third-party
  credit shrunk so it stops competing rather than app typography at all.
- **Don't** make motion carry meaning on its own, and don't exempt a new animation
  from the reduced-motion rule. If it has to move to be understood, redesign it.
- **Don't** name a font the project does not load, and don't add a webfont as a
  standalone edit. The stack must describe what actually renders, and changing what
  renders re-opens every measured width and both baseline sets.
  **This rule was true in one file and false in the app for two milestones.**
  `tailwind.config.js` dropped Inter from its stack and said in its own comment that
  nothing loaded it — no `@font-face`, no stylesheet link, no font package — while
  `ops-control.css` opened with a Google Fonts `@import` for Inter and JetBrains Mono
  and `.app-layout` set `font-family` to a stack headed by Inter. Probed in the browser:
  `Inter loaded`, and the computed family on `h1`, on every `Panel` and on the command
  bar was Inter, not the system face every width in `tokens.css` was measured against.
  A loopback tool with no authentication and no cloud was reaching the public internet
  to decide how wide a column is. The import is gone. **A rule about what the app does
  cannot be checked by reading the file that states it.**
- **Don't** describe one surface with two stylesheets. `ops-control.css` carried a
  second `:root` — `--surface-1`, `--text-primary`, `--sidebar-w` and their own radii,
  shadows and spacing — beside `tokens.css`, and the two disagreed where they met:
  measured, the sidebar rendered `#11151E` against a panel's `#0B111C` with text
  `#F0F2F5` against `#F1F5F9`. Nobody chose either step; they are what two answers to
  one question produce.
- **Don't** leave a rule for a class no component writes. Sixty-one of that file's
  hundred and seventeen were dead — a whole DAG renderer, a whole log viewer, an agent
  list, an attention block, a metrics row — the skeleton of a mockup shipped beside the
  app it was a mockup of. The reverse costs more: a component written against class
  names no stylesheet defines renders as raw HTML and fails no compiler, no linter and
  no DOM assertion, because the element is there and simply has no style. The delivery
  panel spent two milestones that way, under cover of the only fixture for it being one
  that made it return `null`.
- **Don't** compress a row of labelled steps to make it fit. Scroll it, and fade
  the edge that hides content.
- **Don't** render an error as a toast. A notice belongs beside the thing it is
  about, and it names the consequence and the next step.
- **Don't** replace a native control with a custom widget for visual consistency
  alone. The `<select>` stays native because keyboard driving and screen-reader
  announcement come free and cannot regress.
- **Don't** hide an empty state behind a blank pane. Say what is missing and name
  the command that would produce it.
