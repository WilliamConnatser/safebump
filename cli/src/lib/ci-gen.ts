import type { SafebumpConfig } from "./config";

// Pipeline files generated from safebump.yml. All logic lives in the CLI, so
// these stay small: install, `safebump ci`, and the opt-in agent jobs. Vendor
// action inputs follow each action's own docs (claude-code-action,
// codex-action, run-gemini-cli).

const SKILL_REPO = "https://github.com/WilliamConnatser/safebump.git";

const PATHS = ["**/package.json", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/bun.lock", "**/bun.lockb"];

const cloudNeedsOidc = (c: SafebumpConfig) => !!c.ai && ["bedrock", "vertex", "foundry"].includes(c.ai.provider);

// credentials for the AI SDK reviewer and the fix agents, by provider
const providerEnv = (c: SafebumpConfig): string[] => {
  switch (c.ai?.provider) {
    case "anthropic":
      return ["ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}"];
    case "openai":
      return ["OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}"];
    case "azure-openai":
      return ["AZURE_API_KEY: ${{ secrets.AZURE_OPENAI_API_KEY }}", "AZURE_OPENAI_API_KEY: ${{ secrets.AZURE_OPENAI_API_KEY }}"];
    case "google":
      return ["GOOGLE_GENERATIVE_AI_API_KEY: ${{ secrets.GEMINI_API_KEY }}", "GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}"];
    case "openai-compatible":
      return ["SAFEBUMP_AI_API_KEY: ${{ secrets.SAFEBUMP_AI_API_KEY }}"];
    case "bedrock":
      return [`AWS_REGION: ${c.ai.region ?? ""}`];
    case "vertex":
      return [`GOOGLE_CLOUD_PROJECT: ${c.ai.project ?? ""}`, `GOOGLE_CLOUD_LOCATION: ${c.ai.region ?? ""}`, `ANTHROPIC_VERTEX_PROJECT_ID: ${c.ai.project ?? ""}`, `CLOUD_ML_REGION: ${c.ai.region ?? ""}`];
    case "foundry":
      return [`ANTHROPIC_FOUNDRY_BASE_URL: ${c.ai.baseURL ?? ""}`];
    default:
      return [];
  }
};

const cloudAuthSteps = (c: SafebumpConfig, indent: string): string[] => {
  const p = c.ai?.provider;
  if (p === "bedrock") {
    return [
      "- uses: aws-actions/configure-aws-credentials@v4",
      "  with:",
      "    role-to-assume: ${{ secrets.AWS_ROLE_TO_ASSUME }}",
      `    aws-region: ${c.ai!.region}`,
    ].map((l) => indent + l);
  }
  if (p === "vertex") {
    return [
      "- uses: google-github-actions/auth@v2",
      "  with:",
      "    workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}",
      "    service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}",
    ].map((l) => indent + l);
  }
  if (p === "foundry") {
    return [
      "- uses: azure/login@v2",
      "  with:",
      "    client-id: ${{ secrets.AZURE_CLIENT_ID }}",
      "    tenant-id: ${{ secrets.AZURE_TENANT_ID }}",
      "    subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}",
    ].map((l) => indent + l);
  }
  return [];
};

const setupSteps = (ref: string, indent: string) =>
  [
    "- uses: actions/checkout@v4",
    "  with:",
    `    ref: ${ref}`,
    "    fetch-depth: 0",
    "    # agents read untrusted text (release notes, package docs): keep",
    "    # push credentials out of the working copy",
    "    persist-credentials: false",
    "- uses: actions/setup-node@v4",
    "  with:",
    "    node-version: 22",
    "- name: Fetch safebump",
    "  run: |",
    `    git clone --quiet --depth 1 --filter=blob:none --sparse ${SKILL_REPO} ../safebump`,
    "    git -C ../safebump sparse-checkout set skills/safebump",
    "- run: $SAFEBUMP install",
  ].map((l) => indent + l);

const fixAgentStep = (c: SafebumpConfig, indent: string): string[] => {
  const ai = c.ai!;
  const lines: string[] = [];
  switch (ai.fix.agent) {
    case "claude-code":
      lines.push(
        "- uses: anthropics/claude-code-action@v1",
        "  with:",
        "    prompt: ${{ steps.prep.outputs.prompt }}",
        "    github_token: ${{ secrets.GITHUB_TOKEN }}",
        "    claude_args: |",
        `      --model ${ai.model}`,
        '      --allowedTools "Bash,Read,Edit,Write,Glob,Grep,WebFetch"',
        ...(ai.provider === "anthropic" ? ["    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}"] : []),
        ...(ai.provider === "bedrock" ? ['    use_bedrock: "true"'] : []),
        ...(ai.provider === "vertex" ? ['    use_vertex: "true"'] : []),
        ...(ai.provider === "foundry" ? ['    use_foundry: "true"'] : []),
      );
      break;
    case "codex":
      lines.push(
        "- uses: openai/codex-action@v1",
        "  with:",
        "    prompt-file: ${{ steps.prep.outputs.prompt_file }}",
        `    model: ${ai.model}`,
        '    permission-profile: ":workspace"',
        ...(ai.provider === "azure-openai"
          ? ["    openai-api-key: ${{ secrets.AZURE_OPENAI_API_KEY }}", `    responses-api-endpoint: ${ai.baseURL?.replace(/\/$/, "")}/openai/v1/responses`]
          : ["    openai-api-key: ${{ secrets.OPENAI_API_KEY }}"]),
      );
      break;
    case "gemini":
      lines.push(
        "- uses: google-github-actions/run-gemini-cli@v0",
        "  with:",
        "    prompt: ${{ steps.prep.outputs.prompt }}",
        `    gemini_model: ${ai.model}`,
        ...(ai.provider === "vertex"
          ? [
              "    use_vertex_ai: 'true'",
              "    gcp_workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}",
              "    gcp_service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}",
              `    gcp_project_id: ${ai.project}`,
              `    gcp_location: ${ai.region}`,
            ]
          : ["    gemini_api_key: ${{ secrets.GEMINI_API_KEY }}"]),
      );
      break;
    default:
      lines.push("- run: $SAFEBUMP agent --mode fix --run --base \"$BASE_REF\"", "  env:", ...providerEnv(c).map((e) => `    ${e}`));
  }
  return lines.map((l) => indent + l);
};

export const githubWorkflow = (c: SafebumpConfig) => {
  const ai = c.mode === "ai" ? c.ai : undefined;
  const oidc = cloudNeedsOidc(c);
  const head = "${{ github.event.pull_request.head.sha }}";
  const branch = "${{ github.head_ref }}";
  const L: string[] = [
    "# Generated by `safebump init` from safebump.yml. Change safebump.yml and run",
    "# `safebump init --write-ci` again rather than editing this file by hand.",
    "#",
    "# Statuses: `safebump` (make it REQUIRED in branch protection: red only when",
    "# the upgrade is broken) and `safebump/automerge` (NOT required: green only",
    "# when the checks prove low risk; Renovate with platformAutomerge: false",
    "# won't merge while it's red).",
    "name: safebump",
    "",
    "on:",
    "  pull_request:",
    "    types: [opened, synchronize, reopened]",
    "    paths:",
    ...PATHS.map((p) => `      - "${p}"`),
    "",
    "permissions:",
    "  contents: read",
    "",
    "concurrency:",
    "  group: safebump-${{ github.head_ref }}",
    "  cancel-in-progress: true",
    "",
    "env:",
    "  BASE_REF: origin/${{ github.base_ref }}",
    "  SAFEBUMP: ${{ github.workspace }}/../safebump/skills/safebump/scripts/safebump",
    "",
    "jobs:",
    "  assure:",
    "    name: safebump assurance",
    "    if: github.event.pull_request.head.repo.full_name == github.repository",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 45",
    "    permissions:",
    "      contents: read",
    "      pull-requests: write",
    "      statuses: write",
    "    outputs:",
    "      agent_mode: ${{ steps.ci.outputs.agent_mode }}",
    "      risk: ${{ steps.ci.outputs.risk }}",
    "    steps:",
    ...setupSteps(head, "      "),
    "      - id: ci",
    '        run: $SAFEBUMP ci --base "$BASE_REF" --baseline --post',
    "        env:",
    "          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "      - uses: actions/upload-artifact@v4",
    "        if: always()",
    "        with:",
    "          name: safebump",
    "          path: .safebump/",
    "          include-hidden-files: true",
  ];

  if (ai?.review.enabled) {
    L.push(
      "",
      "  review:",
      "    name: safebump review (AI)",
      "    needs: assure",
      "    if: always() && needs.assure.outputs.agent_mode == 'review'",
      "    runs-on: ubuntu-latest",
      "    timeout-minutes: 60",
      "    permissions:",
      "      contents: write",
      "      pull-requests: write",
      "      statuses: write",
      ...(oidc ? ["      id-token: write"] : []),
      "    steps:",
      ...setupSteps(branch, "      "),
      "      - uses: actions/download-artifact@v4",
      "        with:",
      "          name: safebump",
      "          path: .safebump/",
      ...cloudAuthSteps(c, "      "),
      '      - run: $SAFEBUMP agent --mode review --base "$BASE_REF" --post',
      "        env:",
      "          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      "          SAFEBUMP_PUSH_TOKEN: ${{ secrets.SAFEBUMP_PUSH_TOKEN }}",
      ...providerEnv(c).map((e) => `          ${e}`),
    );
  }

  if (ai?.fix.enabled) {
    L.push(
      "",
      "  fix:",
      `    name: safebump fix (AI, ${ai.fix.agent})`,
      "    needs: assure",
      "    if: always() && needs.assure.outputs.agent_mode == 'fix'",
      "    runs-on: ubuntu-latest",
      "    timeout-minutes: 90",
      "    permissions:",
      "      contents: write",
      "      pull-requests: write",
      "      statuses: write",
      ...(oidc || ai.fix.agent === "gemini" ? ["      id-token: write"] : []),
      // vendor actions read cloud settings (AWS_REGION, Vertex project and
      // region, the Foundry URL) from the job's environment
      ...(providerEnv(c).some((e) => !e.includes("${{"))
        ? ["    env:", ...providerEnv(c).filter((e) => !e.includes("${{")).map((e) => `      ${e}`)]
        : []),
      "    steps:",
      ...setupSteps(branch, "      "),
      "      - uses: actions/download-artifact@v4",
      "        with:",
      "          name: safebump",
      "          path: .safebump/",
      "      - id: prep",
      '        run: $SAFEBUMP agent --mode fix --prepare --base "$BASE_REF"',
      ...(ai.fix.agent === "gemini" ? [] : cloudAuthSteps(c, "      ")),
      ...fixAgentStep(c, "      "),
      "      - if: always()",
      '        run: $SAFEBUMP agent --mode fix --finish --base "$BASE_REF" --post',
      "        env:",
      "          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      "          # optional: pushes with the default token don't start new runs",
      "          SAFEBUMP_PUSH_TOKEN: ${{ secrets.SAFEBUMP_PUSH_TOKEN }}",
    );
  }
  return `${L.join("\n")}\n`;
};

export const gitlabCi = (c: SafebumpConfig) => {
  const ai = c.mode === "ai" ? c.ai : undefined;
  const bedrock = ai?.provider === "bedrock";
  const L: string[] = [
    "# Generated by `safebump init` from safebump.yml. Change safebump.yml and run",
    "# `safebump init --write-ci` again rather than editing this file by hand.",
    "#",
    "# Variables: SAFEBUMP_GITLAB_TOKEN (project access token, Developer, api +",
    "# write_repository). The safebump job fails the pipeline when the upgrade",
    "# is broken, and posts a `safebump/automerge` status that Renovate",
    "# (platformAutomerge: false) waits on.",
    "",
    ".safebump:",
    "  image: node:22",
    "  rules:",
    '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"',
    "      changes:",
    ...PATHS.map((p) => `        - "${p}"`),
    "  variables:",
    "    GIT_DEPTH: 0",
    "    BASE_REF: origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
    "    SAFEBUMP: /opt/safebump/skills/safebump/scripts/safebump",
    // GitLab exposes CI/CD variables directly; map them to the names the
    // reviewer and agents read
    ...(ai ? providerEnv(c).map((e) => `    ${e.replace(/\$\{\{ secrets\.([A-Z_]+) \}\}/, "$$$1")}`).filter((e) => !/^\s+([A-Z_]+): \$\1$/.test(e)) : []),
    "  before_script:",
    `    - git clone --quiet --depth 1 --filter=blob:none --sparse ${SKILL_REPO} /opt/safebump`,
    "    - git -C /opt/safebump sparse-checkout set skills/safebump",
    '    - git fetch --quiet origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"',
    "    - $SAFEBUMP install",
    ...(bedrock
      ? [
          "    # Bedrock via GitLab OIDC: the AWS SDK reads these natively",
          '    - echo "$SAFEBUMP_AWS_OIDC" > /tmp/aws-oidc && export AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/aws-oidc AWS_ROLE_ARN="$SAFEBUMP_AWS_ROLE_ARN"',
        ]
      : []),
    "",
    "safebump:",
    "  extends: .safebump",
    "  stage: test",
    "  script:",
    '    - $SAFEBUMP ci --base "$BASE_REF" --baseline --post --outputs safebump.env',
    "  artifacts:",
    "    when: always",
    "    paths: [.safebump/]",
    "    reports:",
    "      dotenv: safebump.env",
  ];
  if (ai) {
    for (const mode of ["review", "fix"] as const) {
      if (!ai[mode].enabled) continue;
      L.push(
        "",
        `safebump-${mode}:`,
        "  extends: .safebump",
        "  stage: deploy",
        "  needs:",
        "    - job: safebump",
        "      artifacts: true",
        "  when: always",
        "  timeout: 90m",
        ...(bedrock ? ["  id_tokens:", "    SAFEBUMP_AWS_OIDC:", "      aud: sts.amazonaws.com"] : []),
        "  script:",
        `    - 'if [ "$AGENT_MODE" != "${mode}" ]; then echo "no ${mode} needed (AGENT_MODE=$AGENT_MODE)"; exit 0; fi'`,
        '    - git checkout -B "$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME" "$CI_COMMIT_SHA"',
        `    - $SAFEBUMP agent --mode ${mode} --base "$BASE_REF" --post`,
      );
    }
  }
  return `${L.join("\n")}\n`;
};

// what the person has to set up on the CI platform for this config
export const setupChecklist = (c: SafebumpConfig): string[] => {
  const items: string[] = [];
  if (c.ci.platform === "github") {
    items.push("Branch protection: require the `safebump` status. Leave `safebump/automerge` NOT required.");
    items.push("Optional secret SAFEBUMP_PUSH_TOKEN (fine-grained, contents: write) so pushes from the fix job trigger new runs.");
  } else {
    items.push("CI/CD variable SAFEBUMP_GITLAB_TOKEN: a project access token (role Developer, scopes api + write_repository).");
  }
  if (c.mode !== "ai" || !c.ai) {
    items.push("Deterministic mode: no AI credentials needed.");
    return items;
  }
  const gh = c.ci.platform === "github";
  const secret = (name: string) => (gh ? `secret ${name}` : `CI/CD variable ${name} (masked)`);
  switch (c.ai.provider) {
    case "anthropic":
      items.push(`${secret("ANTHROPIC_API_KEY")}.`);
      break;
    case "openai":
      items.push(`${secret("OPENAI_API_KEY")}.`);
      break;
    case "azure-openai":
      items.push(`${secret("AZURE_OPENAI_API_KEY")}; ai.baseURL is your resource URL (https://<resource>.openai.azure.com).`);
      break;
    case "google":
      items.push(`${secret("GEMINI_API_KEY")} (Google AI Studio).`);
      break;
    case "openai-compatible":
      items.push(`${secret("SAFEBUMP_AI_API_KEY")} if your endpoint needs a key.`);
      break;
    case "bedrock":
      items.push(
        gh
          ? "AWS: an IAM role trusting GitHub's OIDC provider, allowed bedrock:InvokeModel*; secret AWS_ROLE_TO_ASSUME with its ARN."
          : "AWS: an IAM role trusting your GitLab instance's OIDC provider (aud sts.amazonaws.com), allowed bedrock:InvokeModel*; CI/CD variable SAFEBUMP_AWS_ROLE_ARN with its ARN.",
      );
      break;
    case "vertex":
      items.push(
        gh
          ? "Google Cloud: Workload Identity Federation for GitHub, a service account with roles/aiplatform.user; secrets GCP_WORKLOAD_IDENTITY_PROVIDER and GCP_SERVICE_ACCOUNT."
          : "Google Cloud: Workload Identity Federation for GitLab; a credential-config file as CI/CD file variable GOOGLE_APPLICATION_CREDENTIALS; the service account needs roles/aiplatform.user.",
      );
      break;
    case "foundry":
      items.push("Azure: a federated credential for this repo; secrets AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID.");
      break;
  }
  return items;
};
