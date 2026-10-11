import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { warnIfProxyConfigured } from "./proxyWarning.js";

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

describe("warnIfProxyConfigured", () => {
  let saved: Record<string, string | undefined>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    saved = {};
    for (const name of PROXY_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    for (const name of PROXY_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  test("is silent when no proxy variable is set", () => {
    warnIfProxyConfigured();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("ignores empty values", () => {
    process.env.HTTPS_PROXY = "";
    warnIfProxyConfigured();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  for (const name of PROXY_VARS) {
    test(`${name} alone produces a singular one-line warning`, () => {
      process.env[name] = "http://proxy.invalid:3128";
      warnIfProxyConfigured();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const message = errorSpy.mock.calls[0][0] as string;
      expect(message).toStartWith(`markdownify-mcp: ${name} is set, `);
      expect(message).toContain("do not use a proxy");
      expect(message).not.toContain("\n");
    });
  }

  test("several variables are listed together in a plural warning", () => {
    process.env.HTTPS_PROXY = "http://a.invalid:1";
    process.env.HTTP_PROXY = "http://b.invalid:2";
    warnIfProxyConfigured();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0][0] as string;
    expect(message).toStartWith("markdownify-mcp: HTTPS_PROXY, HTTP_PROXY are set, ");
  });

  test("never writes to stdout", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      process.env.HTTP_PROXY = "http://a.invalid:1";
      warnIfProxyConfigured();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
