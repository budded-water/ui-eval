# Basic Web feature map

This review aid references executable configuration; it is not loaded by UI
Eval. Actual outcomes live in generated reports, not in this table. Follow the
[verification workflow](../../../docs/verification.md) when maintaining it.

| User journey | Preconditions and entry | Executable proof | Coverage gaps |
| --- | --- | --- | --- |
| Open the example home and see its heading | Start with the configured server port free; open the scenario's home entry | [home-desktop](scenarios/home-desktop.json): step assertion `home-heading-text`, checkpoint `ready` assertions `home-main-visible`, `home-heading-visible`, `home-no-crash`; [policy](policies/default.json) supplies the core execution/interaction/runtime gates | Only the declared desktop/locale/theme variant and `/` entry; no interaction, persistence, mobile, alternate `/index.html` entry, baseline comparison or geometry proof |

Selectors, expected values, channels and matrix settings are canonical in the
linked scenario. Startup and profile settings are canonical in
[project.json](project.json). A screenshot at `ready` is captured evidence, not
proof that the page matches a design. Run the [example commands](../README.md)
and inspect both report projections before claiming this journey verified.
