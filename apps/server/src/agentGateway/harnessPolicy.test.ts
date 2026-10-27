import { assert, describe, it } from "@effect/vitest";
import { AUTOMATION_AUTHORING_GUIDANCE } from "./automationAuthoringGuidance.ts";

import {
  renderSaintHarnessPolicy,
  SAINT_HARNESS_POLICY_MARKER,
  takeSaintHarnessPolicyForProviderSession,
  takeSaintHarnessPolicyTextPartForProviderSession,
  takeSaintHarnessPolicyForSession,
} from "./harnessPolicy.ts";

describe("Saint harness policy", () => {
  it("defers duplicate automation authoring text while preserving tool routing and run rules", () => {
    const inline = renderSaintHarnessPolicy({ gatewayControlAvailable: true });
    const deferred = renderSaintHarnessPolicy({
      gatewayControlAvailable: true,
      automationAuthoring: "tool-descriptions",
    });
    assert.equal(deferred, inline.replace(`${AUTOMATION_AUTHORING_GUIDANCE}\n`, ""));
    assert.include(deferred, "saint_create_automation");
    assert.include(deferred, "saint_view_automation");
    assert.include(deferred, "saint_report_automation_result");
  });

  it("includes honest completion evidence and opt-in delegated E2E testing", () => {
    const policy = renderSaintHarnessPolicy({ gatewayControlAvailable: true });
    for (const text of [
      "completion report",
      "artifactPath",
      "![Result description]",
      "explicitly asked",
      "saint_e2e_review",
      "Do not load it for unrelated work",
    ]) {
      assert.include(policy, text);
    }
    assert.notInclude(
      renderSaintHarnessPolicy({ gatewayControlAvailable: false }),
      "browser_screenshot({kind:'proof'})",
    );
  });

  it("identifies Saint and explains exact batch coordination when MCP is available", () => {
    const policy = renderSaintHarnessPolicy({ gatewayControlAvailable: true });
    assert.include(policy, SAINT_HARNESS_POLICY_MARKER);
    assert.include(policy, "Saint is the host and harness");
    assert.include(policy, "one exact saint_create_threads plan");
    assert.include(policy, "before returning an operationId");
    assert.include(policy, "saint_wait_for_threads");
    assert.include(policy, "saint_set_thread_pull_request");
    assert.include(policy, "current thread's own deliverable");
    assert.include(policy, "only reviews, references, or discusses");
    assert.include(policy, "use browser_* autonomously");
    assert.include(policy, "canonical, complete control surface");
    assert.include(policy, "never substitute Chrome");
    assert.include(policy, "user's active chat");
    assert.include(policy, "Detailed rules live in each tool description");
    assert.notInclude(policy, "BrowserInterruptedByHuman");
    assert.notInclude(policy, "start with browser_open");
    assert.include(policy, "do not create Saint threads");
    assert.include(policy, "specific 3–8 word outcome label");
    assert.include(policy, "Assume no chat context");
    assert.include(policy, "notify-versus-silent criteria");
    assert.include(policy, 'later manual follow-up such as "continue"');
    assert.include(policy, "Never call this tool for a manual follow-up turn");
  });

  it("asks agents to emit known absolute file URLs instead of invented relative links", () => {
    const gateway = renderSaintHarnessPolicy({ gatewayControlAvailable: true });
    const identityOnly = renderSaintHarnessPolicy({ gatewayControlAvailable: false });

    for (const policy of [gateway, identityOnly]) {
      assert.include(policy, "[config.ts](file:///absolute/path/config.ts)");
      assert.include(policy, "Relative links are only for the session working directory");
      assert.include(policy, "use plain text and never invent a path");
    }
  });

  it("keeps final answers self-contained when intermediate progress is collapsed", () => {
    const gateway = renderSaintHarnessPolicy({ gatewayControlAvailable: true });
    const identityOnly = renderSaintHarnessPolicy({ gatewayControlAvailable: false });

    for (const policy of [gateway, identityOnly]) {
      assert.include(policy, 'under "Worked for..."');
      assert.include(policy, "Final responses must restate every needed scope");
      assert.include(policy, 'Never request approval using "this", "the above"');
      assert.include(policy, "structured user-input tool");
      assert.include(policy, "include all decision context");
    }
  });

  it("never advertises gateway mutation to providers without scoped MCP", () => {
    const policy = renderSaintHarnessPolicy({ gatewayControlAvailable: false });
    assert.include(policy, "Saint MCP control is unavailable");
    assert.notInclude(policy, "one exact saint_create_threads plan");
  });

  it("delivers a private host-context block once per provider session", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    assert.include(
      takeSaintHarnessPolicyForSession(state, { gatewayControlAvailable: true }) ?? "",
      "<saint_host_context>",
    );
    assert.isNull(takeSaintHarnessPolicyForSession(state, { gatewayControlAvailable: true }));

    // The text-part form ACP adapters inject obeys the same once-per-session latch.
    const partState: { harnessPolicyDelivered?: boolean } = {};
    const input = { provider: "cursor", scopedGatewayConnectionAvailable: true } as const;
    assert.include(
      takeSaintHarnessPolicyTextPartForProviderSession(partState, input)?.text ?? "",
      SAINT_HARNESS_POLICY_MARKER,
    );
    assert.isNull(takeSaintHarnessPolicyTextPartForProviderSession(partState, input));
  });

  it("keeps OpenCode and Pi identity-only until scoped setup succeeds", () => {
    for (const provider of ["opencode", "pi"] as const) {
      const text =
        takeSaintHarnessPolicyForProviderSession(
          {},
          { provider, scopedGatewayConnectionAvailable: false },
        ) ?? "";
      assert.include(text, SAINT_HARNESS_POLICY_MARKER, provider);
      assert.include(text, "Saint MCP control is unavailable", provider);
      assert.notInclude(text, "one exact saint_create_threads plan", provider);
    }
  });

  it("routes iOS work to device tools without embedding per-tool instructions", () => {
    const policy = renderSaintHarnessPolicy({ gatewayControlAvailable: true });
    assert.include(policy, "any-language iOS app or simulator request");
    assert.include(policy, "call device_* directly and autonomously");
    assert.include(policy, "never use xcrun simctl");
    assert.include(policy, "open Simulator.app");
    assert.include(policy, "user watches the streamed pane");
    assert.notInclude(policy, "device_list first");
    assert.notInclude(policy, "com.apple.Preferences");
  });

  it("keeps hub roles out of reach of a worker without loosening normal conversations", () => {
    // Sessions with gateway control get the hub role line; sessions without it
    // are told nothing about hub routing they cannot perform anyway.
    const policy = renderSaintHarnessPolicy({ gatewayControlAvailable: true });
    assert.include(policy, "Hub roles come from the server");
    assert.include(policy, "the coordinator routes assigned hub work and owns hub automations");
    assert.include(
      policy,
      "workers do their assigned work and cannot create threads or message other threads",
    );
    assert.include(policy, "Other conversations retain ordinary thread tools.");
    assert.notInclude(
      renderSaintHarnessPolicy({ gatewayControlAvailable: false }),
      "Hub roles come from the server",
    );
  });

  it("keeps the gateway policy below its prompt budget", () => {
    // Role guidance adds one line; keep the optional visual guidance in its own budget.
    assert.isAtMost(renderSaintHarnessPolicy({ gatewayControlAvailable: true }).length, 6_250);
    assert.isAtMost(
      renderSaintHarnessPolicy({ gatewayControlAvailable: true, inlineVisuals: true }).length,
      6_380,
    );
  });

  it("points to saint_show_visual only when the session can call it", () => {
    const visualLine = "call saint_show_visual and place its block in your reply";
    assert.include(
      renderSaintHarnessPolicy({ gatewayControlAvailable: true, inlineVisuals: true }),
      visualLine,
    );
    assert.notInclude(renderSaintHarnessPolicy({ gatewayControlAvailable: true }), visualLine);
    assert.notInclude(
      renderSaintHarnessPolicy({ gatewayControlAvailable: false, inlineVisuals: true }),
      visualLine,
    );
  });

  it("withholds device guidance from sessions with no gateway control", () => {
    const policy = renderSaintHarnessPolicy({ gatewayControlAvailable: false });

    // Promising tools this session cannot reach would be a lie.
    assert.notInclude(policy, "device_list");
    assert.notInclude(policy, "device_describe_ui");
  });

  it("includes Computer tool guidance only when the session can use Computer", () => {
    for (const gatewayControlAvailable of [true, false] as const) {
      for (const enableComputerControl of [true, false, undefined] as const) {
        const policy = renderSaintHarnessPolicy({
          gatewayControlAvailable,
          ...(enableComputerControl === undefined ? {} : { enableComputerControl }),
        });
        const scope = `${gatewayControlAvailable}/${enableComputerControl}`;
        if (gatewayControlAvailable && enableComputerControl === true) {
          assert.include(policy, "## Saint computer use", scope);
          assert.include(policy, "The computer_* tools are live on this session", scope);
        } else {
          assert.notInclude(policy, "## Saint computer use", scope);
          assert.notInclude(policy, "computer_", scope);
          assert.notInclude(policy, "turn Computer control on in Settings", scope);
        }
      }
    }
  });
});

it("adds Computer guidance only for an explicitly enabled scoped session across all providers", () => {
  const providers = [
    "codex",
    "claudeAgent",
    "cursor",
    "grok",
    "droid",
    "devin",
    "opencode",
    "pi",
    "antigravity",
  ] as const;
  for (const provider of providers) {
    const off = takeSaintHarnessPolicyForProviderSession(
      {},
      { provider, scopedGatewayConnectionAvailable: true },
    );
    const explicitOff = takeSaintHarnessPolicyForProviderSession(
      { enableComputerControl: false },
      { provider, scopedGatewayConnectionAvailable: true },
    );
    assert.strictEqual(off, explicitOff);
    assert.notInclude(off ?? "", "## Saint computer use");
    assert.notInclude(off ?? "", "computer_", provider);
    const state = { enableComputerControl: true };
    const on =
      takeSaintHarnessPolicyForProviderSession(state, {
        provider,
        scopedGatewayConnectionAvailable: true,
      }) ?? "";
    assert.equal(on.split("## Saint computer use").length - 1, 1, provider);
    assert.include(on, "never replay it");
    assert.isNull(
      takeSaintHarnessPolicyForProviderSession(state, {
        provider,
        scopedGatewayConnectionAvailable: true,
      }),
    );
    assert.notInclude(
      takeSaintHarnessPolicyForProviderSession(
        { enableComputerControl: true },
        { provider, scopedGatewayConnectionAvailable: false },
      ) ?? "",
      "## Saint computer use",
    );
  }
});
