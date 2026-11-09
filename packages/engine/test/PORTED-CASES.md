# Ported D-1 engine test cases

One row per case of the old verify, gate-config and related test files. Class is `counterpart`
(a public test already asserts it, named in the fourth column), `port` (written here, in the file
named by its id, and bitten by the registry entry named beside it) or `project config` (stays with
the project: it asserts that project's own values). Only a `port` row has a Result: `killed`
and the short sha of the tree the planted fault was run on.

| Source | Case | Class | Counterpart or port id | Result |
|---|---|---|---|---|
| verify-ticket | @49 VT-S3 package.json | project config | db:reset and db:schema scripts | |
| verify-ticket | @59 VT-P3d a | project config | the project's seed note text | |
| verify-ticket | @59 VT-P3d b | port | P81 VT-P3d b (INFRA-81a/M1) | killed 1bfb27b |
| verify-ticket | @71 --skip e2e core-only | counterpart | `engine-inputs` EI-4 | |
| verify-ticket | @84 --skip e2e web | counterpart | `engine-inputs` EI-4 | |
| verify-ticket | @93 receiptOk | counterpart | `step-reuse` VR-7 | |
| verify-ticket | @100 --skip human step | port | P81 --skip human step (INFRA-81a/M2) | killed 1bfb27b |
| verify-ticket | @105 unknown --skip | port | P81 unknown --skip (INFRA-81a/M3) | killed 1bfb27b |
| verify-ticket | @115 dry-run reset before e2e | counterpart | `plan-steps` VT-P3a | |
| verify-ticket | @124 dry-run NOT SELECTED | port | P81 dry-run NOT SELECTED (INFRA-81a/M4) | killed 1bfb27b |
| verify-ticket | @137 VT-1 | counterpart | `verify-run` VT-1 | |
| verify-ticket | @150 VT-2 | port | P81 VT-2 (INFRA-81a/M5) | killed 1bfb27b |
| verify-ticket | @165 VT-I2 | project config | core-only step selection, package.json check chain | |
| verify-ticket | @186 VT-I4 | project config | ci.yml filters; guards P5-11/M7, M8 | |
| verify-ticket | @216 --skip ios-bundle | project config | the project's mobile step selection (engine: EI-4) | |
| verify-ticket | @229 prettier failure summary | project config | the project's check step summary | |
| verify-ticket | @244 VT-S1 | port | P81 VT-S1 (INFRA-81a/M6) | killed 1bfb27b |
| verify-ticket | @261 VT-S2 | port | P81 VT-S2 (INFRA-81a/M7) | killed 1bfb27b |
| verify-ticket | @277 VT-S3 summary | port | P81 VT-S3 summary (INFRA-81a/M8) | killed 1bfb27b |
| verify-ticket | @282 VT-S4 | port | P81 VT-S4 (INFRA-81a/M9) | killed 1bfb27b |
| verify-ticket | @297 VT-S5 | port | P81 VT-S5 (INFRA-81a/M10) | killed 1bfb27b |
| verify-ticket | @305 VT-F1 a | counterpart | `verify-run` VT-F1 | |
| verify-ticket | @305 VT-F1 b | port | P81 VT-F1 b (INFRA-81a/M11) | killed 1bfb27b |
| verify-ticket | @339 VT-F2 | counterpart | `verify-run` VT-F2 | |
| verify-ticket | @355 VT-F3 | port | P81 VT-F3 (INFRA-81a/M12) | killed 1bfb27b |
| verify-ticket | @378 VT-F4 | counterpart | `verify-run` VT-F4 | |
| verify-ticket | @389 VH-1 | counterpart | `verify-run` VH-2 (entry shape), VH-7 (history path) | |
| verify-ticket | @406 VH-2 | counterpart | `verify-run` VH-2 | |
| verify-ticket | @421 VH-3 | counterpart | `verify-run` VH-3 | |
| verify-ticket | @427 VH-4 | counterpart | `verify-run` VH-4 | |
| verify-ticket | @438 VH-5 | port | P81 VH-5 (INFRA-81a/M13) | killed 1bfb27b |
| verify-ticket | @452 VH-6 | counterpart | `verify-run` VH-6 | |
| verify-ticket | @469 VH-7 | counterpart | `verify-run` VH-7 | |
| verify-ticket | @487 VH-8 | port | P81 VH-8 (INFRA-81a/M14) | killed 1bfb27b |
| verify-ticket | @500 runInShell noise | port | P81 runInShell noise (INFRA-81a/M15) | killed 1bfb27b |
| verify-ticket | @508 gate killed by signal | port | P81 gate killed by signal (INFRA-81a/M16) | killed 1bfb27b |
| verify-ticket-reuse | @49 VR-1 | port | P81 VR-1 (INFRA-81a/M17) | killed 1bfb27b |
| verify-ticket-reuse | @79 VR-2 | counterpart | `step-reuse` VR-2a, VR-2b | |
| verify-ticket-reuse | @141 VR-3 | project config | the project's deny lists | |
| verify-ticket-reuse | @151 VR-4 a | project config | the project's docs deny rule | |
| verify-ticket-reuse | @151 VR-4 b | port | P81 VR-4 b (INFRA-81a/M18) | killed 1bfb27b |
| verify-ticket-reuse | @169 VR-5 | counterpart | `step-reuse` VR-5 | |
| verify-ticket-reuse | @179 VR-6 | port | P81 VR-6 (INFRA-81a/M19) | killed 1bfb27b |
| verify-ticket-reuse | @189 VR-7 | counterpart | `step-reuse` VR-7, `verify-run` VH-2 | |
| verify-ticket-reuse | @203 VR-8 | port | P81 VR-8 (INFRA-81a/M20) | killed 1bfb27b |
| verify-ticket-reuse | @225 VR-9 | port | P81 VR-9 (INFRA-81a/M21) | killed 1bfb27b |
| verify-ticket-reuse | @243 VL-1 | counterpart | `step-reuse` VG-1 | |
| verify-ticket-reuse | @256 VL-2 | port | P81 VL-2 (INFRA-81a/M22) | killed 1bfb27b |
| verify-ticket-reuse | @281 VL-3 a | counterpart | `step-reuse` VG-3 | |
| verify-ticket-reuse | @281 VL-3 b | port | P81 VL-3 b (INFRA-81a/M23) | killed 1bfb27b |
| verify-ticket-reuse | @316 VL-4 | counterpart | `step-reuse` VG-4 | |
| verify-ticket-reuse | @331 VL-6 | port | P81 VL-6 (INFRA-81a/M24) | killed 1bfb27b |
| verify-ticket-stack | @54 VT-P2 | counterpart | `verify-stack` VT-P2, V-1b | |
| verify-ticket-stack | @91 VT-R1 a | counterpart | `verify-stack` VT-R1 | |
| verify-ticket-stack | @91 VT-R1 b | port | P81 VT-R1 b (INFRA-81a/M25) | killed 1bfb27b |
| verify-ticket-stack | @150 VT-T1 | counterpart | `verify-stack` VT-T1a, VT-T1b | |
| verify-ticket-stack | @181 VT-T1b | port | P81 VT-T1b (INFRA-81a/M26) | killed 1bfb27b |
| verify-ticket-stack | @199 VT-T5 | port | P81 VT-T5 (INFRA-81a/M27) | killed 1bfb27b |
| verify-ticket-stack | @218 VT-T2 | counterpart | `verify-stack` VT-T1a (exit 124 arm) | |
| verify-ticket-stack | @238 VT-T3 a | project config | the project's step limits | |
| verify-ticket-stack | @238 VT-T3 b | port | P81 VT-T3 b (INFRA-81a/M28) | killed 1bfb27b |
| verify-ticket-stack | @271 VT-T4 | counterpart | `verify-stack` VT-T4 | |
| verify-ticket-stack | @288 VT-L1 | port | P81 VT-L1 (INFRA-81a/M29) | killed 1bfb27b |
| verify-ticket-stack | @315 VT-L2 | port | P81 VT-L2 (INFRA-81a/M30) | killed 1bfb27b |
| verify-ticket-stack | @343 VT-D1 | port | P81 VT-D1 (INFRA-81a/M31) | killed 1bfb27b |
| verify-ticket-stack | @373 V-1a | counterpart | `verify-stack` V-1a, V-1c | |
| verify-ticket-stack | @400 V-1f | port | P81 V-1f (INFRA-81a/M32) | killed 1bfb27b |
| verify-ticket-stack | @418 V-1b | counterpart | `verify-stack` V-1b | |
| verify-ticket-stack | @427 V-1c | project config | the project's step list and order (engine: V-1c) | |
| verify-ticket-stack | @456 V-1d | counterpart | `verify-stack` V-1d, `step-reuse` VG-3 | |
| verify-ticket-stack | @496 V-1e | counterpart | `verify-stack` V-1e | |
| verify-ticket-stack | @508 V-2 a | counterpart | `verify-stack` V-2, V-2b | |
| verify-ticket-stack | @508 V-2 b | port | P81 V-2 b (INFRA-81a/M33) | killed 1bfb27b |
| verify-ticket-stack | @566 V-3d | port | P81 V-3d (INFRA-81a/M34) | killed 1bfb27b |
| verify-ticket-stack | @654 V-3a | project config | guards INFRA-30/M6, INFRA-83c/M4 | |
| verify-ticket-stack | @668 V-3b | project config | guard INFRA-30/M8 | |
| verify-ticket-stack | @695 V-3c | project config | the project's precheck list on a clean tree | |
| verify-ticket-mutation | @40 VT-M2 | project config | the project's mutation targets (engine: `score/targets-select`) | |
| verify-ticket-mutation | @59 VT-M8 | project config | the project's test-to-module mapping (engine: ST-3) | |
| verify-ticket-mutation | @81 VT-M3 | project config | the project's mutated directories | |
| verify-ticket-mutation | @92 VT-M4 | project config | project selection (engine: ST-2) | |
| verify-ticket-mutation | @102 VT-M5 | project config | guard INFRA-11/M10 | |
| verify-ticket-mutation | @115 VT-M7 | counterpart | `engine-inputs` EI-4 | |
| verify-ticket-mutation | @139 VT-MR2 | project config | guard INFRA-27/M13 | |
| verify-ticket-mutation | @169 VT-MR3 | project config | the project's registry step summary | |
| verify-ticket-mutation | @195 VT-MR4 | project config | project selection of the e2e step | |
| verify-ticket-mutation | @213 VT-MR6b | port | P81 VT-MR6b (INFRA-81a/M35) | killed 1bfb27b |
| verify-ticket-mutation | @244 VT-MR6 | counterpart | `mutations/gate-hooks` GH-2 | |
| gate-config | @43 valid config | counterpart | `config-validation` GC-9 (control) | |
| gate-config | @47 GC-1 | counterpart | `config-validation` GC-1 | |
| gate-config | @54 GC-2 | counterpart | `config-validation` GC-2 | |
| gate-config | @66 GC-3 | counterpart | `config-validation` GC-3 | |
| gate-config | @75 GC-4 | counterpart | `config-validation` GC-4 | |
| gate-config | @91 GC-5 | counterpart | `config-validation` GC-5 | |
| gate-config | @148 GC-6 | counterpart | `config-validation` GC-6 | |
| gate-config | @168 GC-7 | counterpart | `config-validation` GC-7 | |
| gate-config | @177 GC-7b | counterpart | `config-validation` GC-7 (`toString` arm) | |
| gate-config | @184 GC-8 | port | P81 GC-8 (INFRA-81a/M36) | killed 1bfb27b |
| gate-config | @194 pick, allTasksLines | port | P81 pick, allTasksLines (INFRA-81a/M37) | killed 1bfb27b |
| gate-config | @201 GC-0 | project config | the project's steps and limits | |
| gate-config | @276 GC-9 | project config | package.json test script | |
| gate-config | @284 GC-P1 | project config | planner quotes none of the project's step ids | |
| gate-config | @289 GC-P3 | port | P81 GC-P3 (INFRA-81a/M38) | killed 1bfb27b |
| gate-config | @328 INFRA-43 GC-1 | port | P81 INFRA-43 GC-1 (INFRA-81a/M39) | killed 1bfb27b |
| gate-config | @342 INFRA-43 GC-2 | port | P81 INFRA-43 GC-2 (INFRA-81a/M40) | killed 1bfb27b |
| gate-config | @351 INFRA-43 GC-3 | port | P81 INFRA-43 GC-3 (INFRA-81a/M41) | killed 1bfb27b |
| gate-config | @366 INFRA-43 GC-4 | port | P81 INFRA-43 GC-4 (INFRA-81a/M42) | killed 1bfb27b |
| gate-config | @384 INFRA-43 GC-5 | port | P81 INFRA-43 GC-5 (INFRA-81a/M43) | killed 1bfb27b |
| gate-config | @397 INFRA-43 GC-6 | project config | the project's moved values | |
| gate-config | @424 INFRA-47 GC-C1 | project config | the project's command names | |
| gate-engine | @128 EI-1 | counterpart | `engine-inputs` EI-1 | |
| gate-engine | @140 EI-2 | counterpart | `engine-inputs` EI-2 | |
| gate-engine | @166 EI-3 | counterpart | `engine-inputs` EI-3 | |
| gate-engine | @198 EI-4 | counterpart | `engine-inputs` EI-4 | |
| gate-engine | @222 EI-5 | counterpart | `e2e/unit-reuse` EI-5 | |
| entry-points | @24 EP-1 | project config | old-path shim, deleted in 81b | |
| entry-points | @30 EP-2 | project config | old-path shim, deleted in 81b | |
| entry-points | @36 EP-3 | project config | old-path shims, deleted in 81b | |
| entry-points | @45 EP-4 | project config | shim content; guards INFRA-50/M5, M6 retire with the shims | |
| verify-ticket-e2e | @67 VE-2 a | counterpart | `e2e/units` VE-3a, VE-3b |  |
| verify-ticket-e2e | @67 VE-2 b | port | P81 VE-2 b (INFRA-81a/M44) | killed 41748cd |
| verify-ticket-e2e | @91 VE-3 | counterpart | `e2e/units` VE-3a, VE-3b, VE-3c |  |
| verify-ticket-e2e | @123 VE-4 | counterpart | `e2e/units` VE-4 |  |
| verify-ticket-e2e | @155 VE-5 | port | P81 VE-5 (INFRA-81a/M45) | killed 41748cd |
| verify-ticket-e2e | @228 VE-6 a | counterpart | `e2e/units` NU-5 |  |
| verify-ticket-e2e | @228 VE-6 b | port | P81 VE-6 b (INFRA-81a/M46) | killed 41748cd |
| verify-ticket-e2e | @300 VE-7 | port | P81 VE-7 (INFRA-81a/M47) | killed 41748cd |
| verify-ticket-e2e | @330 VE-8 | port | P81 VE-8 (INFRA-81a/M48) | killed 41748cd |
| verify-ticket-e2e | @346 VE-8b | counterpart | `e2e/units` VE-8b |  |
| verify-ticket-e2e | @362 VE-9 | counterpart | `e2e-ledger` VE-9 |  |
| verify-ticket-e2e | @395 VE-10 a | counterpart | `e2e-ledger` VE-10a, VE-10b |  |
| verify-ticket-e2e | @395 VE-10 b | port | P81 VE-10 b (INFRA-81a/M49) | killed 41748cd |
| verify-ticket-e2e | @468 VE-11 | port | P81 VE-11 (INFRA-81a/M50) | killed 41748cd |
| verify-ticket-e2e | @592 VE-12 | port | P81 VE-12 (INFRA-81a/M51) | killed 41748cd |
| verify-ticket-e2e | @666 VE-13 | port | P81 VE-13 (INFRA-81a/M52) | killed 41748cd |
| verify-ticket-e2e | @688 VE-14 | port | P81 VE-14 (INFRA-81a/M53) | killed 41748cd |
