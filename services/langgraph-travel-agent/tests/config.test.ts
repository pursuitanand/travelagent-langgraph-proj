import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";

describe("loadConfig", () => {
  it("defaults to the zero-credential JSON setup", () => {
    const config = loadConfig({});

    expect(config.flights.driver).toBe("json");
    expect(config.flights.dataFile).toBe("data/flights.json");
    expect(config.flights.rollDates).toBe(true);
    expect(config.serper.enabled).toBe(false);
    expect(config.anthropic.enabled).toBe(false);
    expect(config.duffel.enabled).toBe(false);
    expect(config.port).toBe(8080);
  });

  it("rejects an unknown flight repository driver", () => {
    expect(() => loadConfig({ FLIGHT_REPOSITORY: "mongodb" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("requires DATABASE_URL for the postgres driver", () => {
    expect(() => loadConfig({ FLIGHT_REPOSITORY: "postgres" })).toThrow(/requires DATABASE_URL/);
    expect(
      loadConfig({ FLIGHT_REPOSITORY: "postgres", DATABASE_URL: "postgresql://x/y" }).flights
        .driver,
    ).toBe("postgres");
  });

  it("requires DUFFEL_ACCESS_TOKEN for the duffel driver", () => {
    expect(() => loadConfig({ FLIGHT_REPOSITORY: "duffel" })).toThrow(
      /requires DUFFEL_ACCESS_TOKEN/,
    );

    const config = loadConfig({
      FLIGHT_REPOSITORY: "duffel",
      DUFFEL_ACCESS_TOKEN: "duffel_test_abc",
    });
    expect(config.flights.driver).toBe("duffel");
    expect(config.duffel.enabled).toBe(true);
    expect(config.duffel.endpoint).toBe("https://api.duffel.com");
    expect(config.duffel.apiVersion).toBe("v2");
  });

  it("refuses a client timeout shorter than the supplier timeout", () => {
    // Otherwise every slow airline search surfaces as our own timeout.
    expect(() =>
      loadConfig({ DUFFEL_TIMEOUT_MS: "5000", DUFFEL_SUPPLIER_TIMEOUT_MS: "20000" }),
    ).toThrow(/must be greater than/);
  });

  it("enforces Duffel's supplier timeout bounds", () => {
    expect(() => loadConfig({ DUFFEL_SUPPLIER_TIMEOUT_MS: "500" })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() =>
      loadConfig({ DUFFEL_SUPPLIER_TIMEOUT_MS: "90000", DUFFEL_TIMEOUT_MS: "95000" }),
    ).toThrow(/Invalid environment configuration/);
  });

  it("marks providers enabled once a key is present", () => {
    const config = loadConfig({
      SERPER_API_KEY: "serper-key",
      ANTHROPIC_API_KEY: "sk-ant-key",
    });
    expect(config.serper.enabled).toBe(true);
    expect(config.anthropic.enabled).toBe(true);
  });

  it("parses a comma-separated CORS origin list", () => {
    expect(loadConfig({ CORS_ALLOWED_ORIGINS: "https://a.example, https://b.example" })
      .corsAllowedOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(loadConfig({ CORS_ALLOWED_ORIGINS: "*" }).corsAllowedOrigins).toBe("*");
  });
});
