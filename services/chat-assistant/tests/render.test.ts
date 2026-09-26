import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  durationOf,
  renderFlightCards,
  renderMarkdown,
  renderSources,
} from "../public/render.js";

const OFFER = {
  id: "off_1",
  owner: { iata: "BA", name: "British Airways" },
  cabinClass: "premium_economy",
  totalAmount: "1234.50",
  totalCurrency: "USD",
  slices: [
    {
      origin: "LHR",
      destination: "NRT",
      departingAt: "2026-10-20T09:00:00+01:00",
      arrivingAt: "2026-10-21T06:00:00+09:00",
      durationMinutes: 720,
      segments: [{ flightNumber: "BA005" }],
    },
  ],
};

describe("escapeHtml", () => {
  it("escapes every character that could start a tag or break an attribute", () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;",
    );
  });
});

describe("renderMarkdown", () => {
  it("renders headings, bullets, bold and paragraphs", () => {
    const html = renderMarkdown("### Route\n\nSome text\n\n- one\n- two");

    expect(html).toContain("<h3>Route</h3>");
    expect(html).toContain("<p>Some text</p>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
  });

  it("renders bold, italic and inline code", () => {
    const html = renderMarkdown("**Cheapest:** _refundable_ `BA005`");
    expect(html).toContain("<strong>Cheapest:</strong>");
    expect(html).toContain("<em>refundable</em>");
    expect(html).toContain("<code>BA005</code>");
  });

  it("renders http links with safe rel attributes", () => {
    const html = renderMarkdown("See [the guide](https://example.com/tokyo).");
    expect(html).toContain(
      '<a href="https://example.com/tokyo" target="_blank" rel="noopener noreferrer">the guide</a>',
    );
  });

  it("never emits a tag that came from the model", () => {
    const html = renderMarkdown('<script>alert("pwned")</script>\n\nhello');

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<p>hello</p>");
  });

  it("refuses javascript: link targets", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).toContain("javascript:alert(1)");
  });

  it("handles empty and missing input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown(undefined)).toBe("");
  });
});

describe("renderFlightCards", () => {
  it("renders one card per offer with route, price and metadata", () => {
    const html = renderFlightCards("Outbound", [OFFER]);

    expect(html).toContain("Outbound");
    expect(html).toContain("LHR 09:00");
    expect(html).toContain("NRT 06:00");
    expect(html).toContain("USD 1234.50");
    expect(html).toContain("British Airways BA005");
    expect(html).toContain("12h 00m");
    expect(html).toContain("non-stop");
    expect(html).toContain("premium economy");
  });

  it("marks an arrival that lands on the next day", () => {
    expect(renderFlightCards("Outbound", [OFFER])).toContain("+1d");
  });

  it("counts stops from the segment list", () => {
    const twoLegs = {
      ...OFFER,
      slices: [
        {
          ...OFFER.slices[0],
          segments: [{ flightNumber: "BA1" }, { flightNumber: "BA2" }],
        },
      ],
    };
    expect(renderFlightCards("Outbound", [twoLegs])).toContain("1 stop");
  });

  it("renders nothing for an empty or missing list", () => {
    expect(renderFlightCards("Outbound", [])).toBe("");
    expect(renderFlightCards("Outbound", undefined)).toBe("");
  });

  it("escapes hostile values coming back from the API", () => {
    const hostile = { ...OFFER, owner: { name: "<script>x</script>" } };
    const html = renderFlightCards("Outbound", [hostile]);
    expect(html).not.toContain("<script>");
  });
});

describe("renderSources", () => {
  it("renders one chip per source, preferring the hostname", () => {
    const html = renderSources([
      { title: "Tokyo guide", link: "https://example.com/tokyo", source: "example.com" },
    ]);
    expect(html).toContain('href="https://example.com/tokyo"');
    expect(html).toContain(">example.com<");
  });

  it("drops sources with a non-http link", () => {
    expect(renderSources([{ title: "bad", link: "javascript:alert(1)" }])).toBe("");
  });

  it("renders nothing when there are no sources", () => {
    expect(renderSources([])).toBe("");
    expect(renderSources(undefined)).toBe("");
  });
});

describe("durationOf", () => {
  it("formats minutes as hours and padded minutes", () => {
    expect(durationOf(545)).toBe("9h 05m");
    expect(durationOf(60)).toBe("1h 00m");
    expect(durationOf(undefined)).toBe("0h 00m");
  });
});
