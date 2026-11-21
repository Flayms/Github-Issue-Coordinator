# Changelog

## [0.2.0](https://github.com/Flayms/Issueflow/compare/v0.1.1...v0.2.0) (2026-11-21)


### Features

* init lets the Owner pick any Harness, not only Claude Code ([#192](https://github.com/Flayms/Issueflow/issues/192), REQ-007-08, REQ-007-09) ([#198](https://github.com/Flayms/Issueflow/issues/198)) ([d079ecc](https://github.com/Flayms/Issueflow/commit/d079ecc75ce9773afd029980374d123de4d0caec))


### Bug Fixes

* init lists the repositories without gh's --slurp, which gh 2.46 lacks ([#202](https://github.com/Flayms/Issueflow/issues/202), REQ-007-08) ([#204](https://github.com/Flayms/Issueflow/issues/204)) ([db24dc2](https://github.com/Flayms/Issueflow/commit/db24dc2a356490f440fec66f6fd242ccdf8620d6))

## [0.1.1](https://github.com/Flayms/Issueflow/compare/v0.1.0...v0.1.1) (2026-11-21)


### Bug Fixes

* publish the npm package as @flayms/issueflow ([#199](https://github.com/Flayms/Issueflow/issues/199)) ([db2f388](https://github.com/Flayms/Issueflow/commit/db2f3887e140194bbecc5907a63bf882c9de8ad3))

## 0.1.0 (2026-11-21)


### ⚠ BREAKING CHANGES

* `coordinator` is now `issueflow`; the config moves to ~/.config/issueflow, state to ~/.local/share/issueflow, $COORDINATOR_CONFIG is $ISSUEFLOW_CONFIG and the unit is issueflow.service.
* the config is config.json (run `coordinator init`); config.ts and config.overrides.json are no longer read, and state moves to the XDG data folder unless stateDir is set.

### Features

* install as an npm package with `coordinator init` and a JSON config ([#190](https://github.com/Flayms/Issueflow/issues/190)) ([7e27f19](https://github.com/Flayms/Issueflow/commit/7e27f196e0c15c743a9ad07fafef3e1e6723aad6))
* rename to Issueflow ([#193](https://github.com/Flayms/Issueflow/issues/193)) ([#194](https://github.com/Flayms/Issueflow/issues/194)) ([e0f8434](https://github.com/Flayms/Issueflow/commit/e0f84349c9e2c8b40d114a3bc0cf58229b4dfa1d))


### Bug Fixes

* release PR passes lint and the first release is 0.1.0 ([#196](https://github.com/Flayms/Issueflow/issues/196), REQ-007-13) ([#197](https://github.com/Flayms/Issueflow/issues/197)) ([447ef73](https://github.com/Flayms/Issueflow/commit/447ef7317669f1fdfdb61f6ace67c15adc03fa07))
