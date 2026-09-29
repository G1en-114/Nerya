# Nerya reference homepage

Adapted from the operator's companion `NeryaAI` website: React content,
BackgroundPaths / ContainerScroll, product scenes, output samples, and CSS.
The source license is preserved in `LICENSE`.

The landing page uses a React context for language, theme, and motion. Styles
are scoped to `.nerya-landing` so they do not change the runtime dashboard.
Animation clocks and listeners are cleaned up on navigation. Product actions
route to the real workspace; `/demo/` is the reference site's isolated sample
workspace, with network connections blocked by its content security policy.

Project: Nerya Agent. Hackathon team: WayAgent FX. Represented organizations:
Feixiaohao and WayToWeb4. Community partners: TinTinLand and CDDJAP.
