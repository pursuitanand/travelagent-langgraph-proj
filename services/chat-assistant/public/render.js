/**
 * Pure rendering helpers for the chat UI.
 *
 * No DOM access at import time, so these are unit-tested directly
 * (see tests/render.test.ts).
 */

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Minimal markdown -> HTML for the subset the agent emits.
 *
 * The input is escaped FIRST, so only the tags produced below can ever reach
 * the DOM - model output is never treated as trusted HTML. Link hrefs are
 * restricted to http(s) for the same reason.
 */
export function renderMarkdown(markdown) {
  const inline = (text) =>
    text
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
      )
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])_([^_]+)_/g, "$1<em>$2</em>");

  const html = [];
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };

  for (const rawLine of escapeHtml(markdown ?? "").split("\n")) {
    const line = rawLine.trimEnd();

    if (line.trim() === "") {
      closeList();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      html.push(`<h3>${inline(heading[1])}</h3>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();

  return html.join("");
}

export function timeOf(timestamp) {
  return typeof timestamp === "string" ? timestamp.slice(11, 16) : "";
}

export function dateOf(timestamp) {
  return typeof timestamp === "string" ? timestamp.slice(0, 10) : "";
}

export function durationOf(minutes) {
  const total = Number(minutes) || 0;
  const hours = Math.floor(total / 60);
  return `${hours}h ${String(total % 60).padStart(2, "0")}m`;
}

/** Renders the structured offers from the API as cards. */
export function renderFlightCards(title, offers) {
  if (!Array.isArray(offers) || offers.length === 0) return "";

  const cards = offers
    .map((offer) => {
      const slice = offer?.slices?.[0];
      if (!slice) return "";

      const stops = (slice.segments?.length ?? 1) - 1;
      const stopLabel = stops === 0 ? "non-stop" : `${stops} stop${stops > 1 ? "s" : ""}`;
      const numbers = (slice.segments ?? []).map((segment) => segment.flightNumber).join(" + ");
      const dayShift =
        dateOf(slice.arrivingAt) !== dateOf(slice.departingAt) ? " <sup>+1d</sup>" : "";

      return `
        <div class="flight">
          <div class="flight-route">
            ${escapeHtml(slice.origin)} ${escapeHtml(timeOf(slice.departingAt))}
            &rarr; ${escapeHtml(slice.destination)} ${escapeHtml(timeOf(slice.arrivingAt))}${dayShift}
          </div>
          <div class="flight-price">${escapeHtml(offer.totalCurrency)} ${escapeHtml(offer.totalAmount)}</div>
          <div class="flight-meta">
            ${escapeHtml(offer.owner?.name ?? "")} ${escapeHtml(numbers)}
            &middot; ${escapeHtml(dateOf(slice.departingAt))}
            &middot; ${escapeHtml(durationOf(slice.durationMinutes))}
            &middot; ${stopLabel}
            <span class="badge">${escapeHtml(String(offer.cabinClass ?? "").replace("_", " "))}</span>
          </div>
        </div>`;
    })
    .join("");

  return `<div class="flights"><div class="flights-title">${escapeHtml(title)}</div>${cards}</div>`;
}

export function renderSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return "";

  const chips = sources
    .filter((source) => /^https?:\/\//.test(source?.link ?? ""))
    .map(
      (source) =>
        `<a class="source" href="${escapeHtml(source.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
          source.source || source.title || source.link,
        )}</a>`,
    )
    .join("");

  return chips === "" ? "" : `<div class="sources">${chips}</div>`;
}
