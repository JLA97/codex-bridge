# Codex Bridge Collaboration Triggers

In the situations below, **briefly offer** to involve Codex (unless the user already asked for Codex or authorized Codex collaboration in this conversation, in which case proceed directly). Once engaged, load and follow the `codex-collab` skill:

- **Cross-Model Code Review**: After completing a **non-trivial code change** (multi-file edits, core logic/state transitions, concurrency, protocol/API boundaries, auth/security, or risky refactors). Skip for trivial edits.
- **Second-Opinion Diagnosis**: When root-causing a stubborn bug or failing test remains stuck after **2+ investigation rounds**.
- **Design Consultation**: Before committing to a **high-impact architecture choice, complex refactor, or plan with significant trade-offs**.

Always triage Codex's feedback critically against real code and invariants — fix real defects, not over-defensive boilerplate or out-of-scope churn.
