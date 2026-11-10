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
| verify-ticket | @59 VT-P3d b | port | P81 VT-P3d b (INFRA-81a/M1) | killed b6117ff |
| verify-ticket | @71 --skip e2e core-only | counterpart | `engine-inputs` EI-4 | |
| verify-ticket | @84 --skip e2e web | counterpart | `engine-inputs` EI-4 | |
| verify-ticket | @93 receiptOk | port | P81 receiptOk (INFRA-81a/M152) | killed b6117ff |
| verify-ticket | @100 --skip human step | port | P81 --skip human step (INFRA-81a/M2) | killed b6117ff |
| verify-ticket | @105 unknown --skip | port | P81 unknown --skip (INFRA-81a/M3) | killed b6117ff |
| verify-ticket | @115 dry-run reset before e2e | port | P81 VT-P3a (INFRA-81a/M153) | killed b6117ff |
| verify-ticket | @124 dry-run NOT SELECTED | port | P81 dry-run NOT SELECTED (INFRA-81a/M4) | killed b6117ff |
| verify-ticket | @137 VT-1 | counterpart | `verify-run` VT-1 | |
| verify-ticket | @150 VT-2 | port | P81 VT-2 (INFRA-81a/M5) | killed b6117ff |
| verify-ticket | @165 VT-I2 | project config | core-only step selection, package.json check chain | |
| verify-ticket | @186 VT-I4 | project config | ci.yml filters; guards P5-11/M7, M8 | |
| verify-ticket | @216 --skip ios-bundle | project config | the project's mobile step selection (engine: EI-4) | |
| verify-ticket | @229 prettier failure summary | project config | the project's check step summary | |
| verify-ticket | @244 VT-S1 | port | P81 VT-S1 (INFRA-81a/M6) | killed b6117ff |
| verify-ticket | @261 VT-S2 | port | P81 VT-S2 (INFRA-81a/M7) | killed b6117ff |
| verify-ticket | @277 VT-S3 summary | port | P81 VT-S3 summary (INFRA-81a/M8) | killed b6117ff |
| verify-ticket | @282 VT-S4 | port | P81 VT-S4 (INFRA-81a/M9) | killed b6117ff |
| verify-ticket | @297 VT-S5 | port | P81 VT-S5 (INFRA-81a/M10) | killed b6117ff |
| verify-ticket | @305 VT-F1 a | counterpart | `verify-run` VT-F1 | |
| verify-ticket | @305 VT-F1 b | port | P81 VT-F1 b (INFRA-81a/M11) | killed b6117ff |
| verify-ticket | @339 VT-F2 | counterpart | `verify-run` VT-F2 | |
| verify-ticket | @355 VT-F3 | port | P81 VT-F3 (INFRA-81a/M12) | killed b6117ff |
| verify-ticket | @378 VT-F4 | counterpart | `verify-run` VT-F4 | |
| verify-ticket | @389 VH-1 | port | P81 VH-1 (INFRA-81a/M154) | killed b6117ff |
| verify-ticket | @406 VH-2 | counterpart | `verify-run` VH-2 | |
| verify-ticket | @421 VH-3 | counterpart | `verify-run` VH-3 | |
| verify-ticket | @427 VH-4 | port | P81 VH-4 (INFRA-81a/M155) | killed b6117ff |
| verify-ticket | @438 VH-5 | port | P81 VH-5 (INFRA-81a/M13) | killed b6117ff |
| verify-ticket | @452 VH-6 | counterpart | `verify-run` VH-6 | |
| verify-ticket | @469 VH-7 | counterpart | `verify-run` VH-7 | |
| verify-ticket | @487 VH-8 | port | P81 VH-8 (INFRA-81a/M14) | killed b6117ff |
| verify-ticket | @500 runInShell noise | port | P81 runInShell noise (INFRA-81a/M15) | killed b6117ff |
| verify-ticket | @508 gate killed by signal | port | P81 gate killed by signal (INFRA-81a/M16) | killed b6117ff |
| verify-ticket-reuse | @49 VR-1 | port | P81 VR-1 (INFRA-81a/M17) | killed b6117ff |
| verify-ticket-reuse | @79 VR-2 | port | P81 VR-2 (INFRA-81a/M156) | killed b6117ff |
| verify-ticket-reuse | @141 VR-3 | project config | the project's deny lists | |
| verify-ticket-reuse | @151 VR-4 a | project config | the project's docs deny rule | |
| verify-ticket-reuse | @151 VR-4 b | port | P81 VR-4 b (INFRA-81a/M18) | killed b6117ff |
| verify-ticket-reuse | @169 VR-5 | counterpart | `step-reuse` VR-5 | |
| verify-ticket-reuse | @179 VR-6 | port | P81 VR-6 (INFRA-81a/M19) | killed b6117ff |
| verify-ticket-reuse | @189 VR-7 | port | P81 VR-7 (INFRA-81a/M157, INFRA-81a/M158) | killed b6117ff |
| verify-ticket-reuse | @203 VR-8 | port | P81 VR-8 (INFRA-81a/M20) | killed b6117ff |
| verify-ticket-reuse | @225 VR-9 | port | P81 VR-9 (INFRA-81a/M21) | killed b6117ff |
| verify-ticket-reuse | @243 VL-1 | counterpart | `step-reuse` VG-1 | |
| verify-ticket-reuse | @256 VL-2 | port | P81 VL-2 (INFRA-81a/M22) | killed b6117ff |
| verify-ticket-reuse | @281 VL-3 a | counterpart | `step-reuse` VG-3 | |
| verify-ticket-reuse | @281 VL-3 b | port | P81 VL-3 b (INFRA-81a/M23) | killed b6117ff |
| verify-ticket-reuse | @316 VL-4 | counterpart | `step-reuse` VG-4 | |
| verify-ticket-reuse | @331 VL-6 | port | P81 VL-6 (INFRA-81a/M24) | killed b6117ff |
| verify-ticket-stack | @54 VT-P2 | counterpart | `verify-stack` VT-P2, V-1b | |
| verify-ticket-stack | @91 VT-R1 a | counterpart | `verify-stack` VT-R1 | |
| verify-ticket-stack | @91 VT-R1 b | port | P81 VT-R1 b (INFRA-81a/M25) | killed b6117ff |
| verify-ticket-stack | @150 VT-T1 | counterpart | `verify-stack` VT-T1a, VT-T1b | |
| verify-ticket-stack | @181 VT-T1b | port | P81 VT-T1b (INFRA-81a/M26) | killed b6117ff |
| verify-ticket-stack | @199 VT-T5 | port | P81 VT-T5 (INFRA-81a/M27) | killed b6117ff |
| verify-ticket-stack | @218 VT-T2 | port | P81 VT-T2 (INFRA-81a/M151) | killed b6117ff |
| verify-ticket-stack | @238 VT-T3 a | project config | the project's step limits | |
| verify-ticket-stack | @238 VT-T3 b | port | P81 VT-T3 b (INFRA-81a/M28) | killed b6117ff |
| verify-ticket-stack | @271 VT-T4 | counterpart | `verify-stack` VT-T4 | |
| verify-ticket-stack | @288 VT-L1 | port | P81 VT-L1 (INFRA-81a/M29) | killed b6117ff |
| verify-ticket-stack | @315 VT-L2 | port | P81 VT-L2 (INFRA-81a/M30) | killed b6117ff |
| verify-ticket-stack | @343 VT-D1 | port | P81 VT-D1 (INFRA-81a/M31) | killed b6117ff |
| verify-ticket-stack | @373 V-1a | counterpart | `verify-stack` V-1a, V-1c | |
| verify-ticket-stack | @400 V-1f | port | P81 V-1f (INFRA-81a/M32) | killed b6117ff |
| verify-ticket-stack | @418 V-1b | counterpart | `verify-stack` V-1b | |
| verify-ticket-stack | @427 V-1c | project config | the project's step list and order (engine: V-1c) | |
| verify-ticket-stack | @456 V-1d | port | P81 V-1d (INFRA-81a/M159) | killed b6117ff |
| verify-ticket-stack | @496 V-1e | counterpart | `verify-stack` V-1e | |
| verify-ticket-stack | @508 V-2 a | port | P81 V-2 a (INFRA-81a/M160) | killed b6117ff |
| verify-ticket-stack | @508 V-2 b | port | P81 V-2 b (INFRA-81a/M33) | killed b6117ff |
| verify-ticket-stack | @566 V-3d | port | P81 V-3d (INFRA-81a/M34) | killed b6117ff |
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
| verify-ticket-mutation | @213 VT-MR6b | port | P81 VT-MR6b (INFRA-81a/M35) | killed b6117ff |
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
| gate-config | @184 GC-8 | port | P81 GC-8 (INFRA-81a/M36) | killed b6117ff |
| gate-config | @194 pick, allTasksLines | port | P81 pick, allTasksLines (INFRA-81a/M37) | killed b6117ff |
| gate-config | @201 GC-0 | project config | the project's steps and limits | |
| gate-config | @276 GC-9 | project config | package.json test script | |
| gate-config | @284 GC-P1 | project config | planner quotes none of the project's step ids | |
| gate-config | @289 GC-P3 | port | P81 GC-P3 (INFRA-81a/M38) | killed b6117ff |
| gate-config | @328 INFRA-43 GC-1 | port | P81 INFRA-43 GC-1 (INFRA-81a/M39) | killed b6117ff |
| gate-config | @342 INFRA-43 GC-2 | port | P81 INFRA-43 GC-2 (INFRA-81a/M40) | killed b6117ff |
| gate-config | @351 INFRA-43 GC-3 | port | P81 INFRA-43 GC-3 (INFRA-81a/M41) | killed b6117ff |
| gate-config | @366 INFRA-43 GC-4 | port | P81 INFRA-43 GC-4 (INFRA-81a/M42) | killed b6117ff |
| gate-config | @384 INFRA-43 GC-5 | port | P81 INFRA-43 GC-5 (INFRA-81a/M43) | killed b6117ff |
| gate-config | @397 INFRA-43 GC-6 | project config | the project's moved values | |
| gate-config | @424 INFRA-47 GC-C1 | project config | the project's command names | |
| gate-engine | @128 EI-1 | port | P81 EI-1 (INFRA-81a/M161) | killed b6117ff |
| gate-engine | @140 EI-2 | counterpart | `engine-inputs` EI-2 | |
| gate-engine | @166 EI-3 | counterpart | `engine-inputs` EI-3 | |
| gate-engine | @198 EI-4 | counterpart | `engine-inputs` EI-4 | |
| gate-engine | @222 EI-5 | counterpart | `e2e/unit-reuse` EI-5 | |
| entry-points | @24 EP-1 | project config | old-path shim, deleted in 81b | |
| entry-points | @30 EP-2 | project config | old-path shim, deleted in 81b | |
| entry-points | @36 EP-3 | project config | old-path shims, deleted in 81b | |
| entry-points | @45 EP-4 | project config | shim content; guards INFRA-50/M5, M6 retire with the shims | |
| verify-ticket-e2e | @67 VE-2 a | counterpart | `e2e/units` VE-3a, VE-3b |  |
| verify-ticket-e2e | @67 VE-2 b | port | P81 VE-2 b (INFRA-81a/M44) | killed b6117ff |
| verify-ticket-e2e | @91 VE-3 | port | P81 VE-3 (INFRA-81a/M164) | killed b6117ff |
| verify-ticket-e2e | @123 VE-4 | counterpart | `e2e/units` VE-4 |  |
| verify-ticket-e2e | @155 VE-5 | port | P81 VE-5 (INFRA-81a/M45) | killed b6117ff |
| verify-ticket-e2e | @228 VE-6 a | port | P81 VE-6 a (INFRA-81a/M165) | killed b6117ff |
| verify-ticket-e2e | @228 VE-6 b | port | P81 VE-6 b (INFRA-81a/M46) | killed b6117ff |
| verify-ticket-e2e | @300 VE-7 | port | P81 VE-7 (INFRA-81a/M47) | killed b6117ff |
| verify-ticket-e2e | @330 VE-8 | port | P81 VE-8 (INFRA-81a/M48) | killed b6117ff |
| verify-ticket-e2e | @346 VE-8b | port | P81 VE-8b (INFRA-81a/M166) | killed b6117ff |
| verify-ticket-e2e | @362 VE-9 | port | P81 VE-9 (INFRA-81a/M167, INFRA-81a/M168) | killed b6117ff |
| verify-ticket-e2e | @395 VE-10 a | port | P81 VE-10 a (INFRA-81a/M169, INFRA-81a/M170) | killed b6117ff |
| verify-ticket-e2e | @395 VE-10 b | port | P81 VE-10 b (INFRA-81a/M49) | killed b6117ff |
| verify-ticket-e2e | @468 VE-11 | port | P81 VE-11 (INFRA-81a/M50, INFRA-81a/M171, INFRA-81a/M172, INFRA-81a/M173) | killed b6117ff |
| verify-ticket-e2e | @592 VE-12 | port | P81 VE-12 (INFRA-81a/M51) | killed b6117ff |
| verify-ticket-e2e | @666 VE-13 | port | P81 VE-13 (INFRA-81a/M52) | killed b6117ff |
| verify-ticket-e2e | @688 VE-14 | port | P81 VE-14 (INFRA-81a/M53) | killed b6117ff |
| stack-lock | @60 S-1 | port | P81 S-1 (INFRA-81a/M54) | killed b6117ff |
| stack-lock | @93 S-2 | counterpart | `stack-lock` S-2 | |
| stack-lock | @135 S-3 | port | P81 S-3 (INFRA-81a/M163) | killed b6117ff |
| stack-lock | @161 S-4 | counterpart | `stack-lock` S-4 | |
| stack-lock | @181 S-5 | port | P81 S-5 (INFRA-81a/M55) | killed b6117ff |
| stack-lock | @206 S-6 | counterpart | `stack-lock` S-6 | |
| stack-lock | @218 S-7 | port | P81 S-7 (INFRA-81a/M56) | killed b6117ff |
| stack-lock | @239 S-8 | counterpart | `stack-lock` S-8 | |
| stack-lock | @266 S-9 | port | P81 S-9 (INFRA-81a/M57) | killed b6117ff |
| stack-lock | @288 S-10 | project config | guard INFRA-22/M6 on the project's Playwright config | |
| stack-lock | @324 reapStale race | port | P81 reapStale race (INFRA-81a/M58) | killed b6117ff |
| stack-lock | @366 reaping guard | port | P81 reaping guard (INFRA-81a/M59) | killed b6117ff |
| verify-ticket-lock | @109 VL-1 | counterpart | `verify-lock` VK-1 | |
| verify-ticket-lock | @136 VL-3 | counterpart | `verify-lock` VK-3 | |
| verify-ticket-lock | @168 VL-4 acquires | counterpart | `verify-lock` VK-4 | |
| verify-ticket-lock | @213 VL-4 gives up | counterpart | `verify-lock` VK-4 | |
| verify-ticket-lock | @246 VL-4 no nightlyStatus | port | P81 VL-4 no nightlyStatus (INFRA-81a/M60) | killed b6117ff |
| verify-ticket-lock | @287 VL-2 | port | P81 VL-2 (INFRA-81a/M61) | killed b6117ff |
| verify-ticket-lock | @327 VL-5 | port | P81 VL-5 (INFRA-81a/M62) | killed b6117ff |
| verify-ticket-lock | @388 VL-6 | port | P81 VL-6 (INFRA-81a/M162) | killed b6117ff |
| verify-ticket-lock | @440 VL-7 | project config | guard INFRA-86/M1 on the project's packs (engine: `react/profiler/project` PF-5) | |
| step-inputs | @117 SI-1 | port | P81 SI-1 (INFRA-81a/M63) | killed b6117ff |
| step-inputs | @127 SI-2 | counterpart | `engine-inputs` EI-1 | |
| step-inputs | @135 SI-3 | port | P81 SI-3 (INFRA-81a/M64) | killed b6117ff |
| step-inputs | @145 SI-4 | port | P81 SI-4 (INFRA-81a/M65) | killed b6117ff |
| step-inputs | @151 SI-5 | port | P81 SI-5 (INFRA-81a/M66) | killed b6117ff |
| step-inputs | @166 SI-6 a | counterpart | `step-inputs` SI-6 | |
| step-inputs | @166 SI-6 b | port | P81 SI-6 b (INFRA-81a/M67) | killed b6117ff |
| step-inputs | @187 SI-6b | port | P81 SI-6b (INFRA-81a/M68) | killed b6117ff |
| step-inputs | @202 SI-7 | project config | the project's deny lists (engine: SI-7) | |
| step-inputs | @228 SI-8 | counterpart | `step-inputs` SI-8, `engine-inputs` EI-1 | |
| step-inputs | @241 SI-9 a | project config | the project's reusable ids | |
| step-inputs | @241 SI-9 b | port | P81 SI-9 b (INFRA-81a/M69) | killed b6117ff |
| step-inputs | @267 SI-10 | port | P81 SI-10 (INFRA-81a/M70) | killed b6117ff |
| step-inputs | @273 SI-R1 | project config | the project's data paths (engine: SI-R1) | |
| step-inputs | @308 SI-R2 | project config | the project's tools reading the registry | |
| step-inputs | @348 SI-MR1 | counterpart | `step-inputs` SI-MR1 | |
| step-inputs | @370 S-1 | project config | the project's baseline files | |
| step-inputs | @443 S-2 no reference | project config | the project's e2e inputs | |
| step-inputs | @451 S-2 planted | project config | bites the helper of the case above | |
| step-inputs | @463 SI-G1 | port | P81 SI-G1 (INFRA-81a/M71) | killed b6117ff |
| step-inputs | @474 SI-G2 | project config | the project's docs paths | |
| tree-hash | @62 same bytes | port | P81 same bytes (INFRA-81a/M72) | killed b6117ff |
| tree-hash | @74 untracked excluded | counterpart | `root-and-tree` DR-4 | |
| tree-hash | @82 tracked edit excluded | counterpart | `root-and-tree` DR-4 | |
| tree-hash | @90 untracked byte | port | P81 untracked byte (INFRA-81a/M73) | killed b6117ff |
| tree-hash | @98 committed byte | counterpart | `root-and-tree` DR-4 | |
| tree-hash | @108 reverted | counterpart | `root-and-tree` DR-4 | |
| tree-hash | @118 deleted | port | P81 deleted (INFRA-81a/M74) | killed b6117ff |
| tree-hash | @129 rename | port | P81 rename (INFRA-81a/M75) | killed b6117ff |
| tree-hash | @140 exec bit | port | P81 exec bit (INFRA-81a/M76) | killed b6117ff |
| tree-hash | @148 odd names | port | P81 odd names (INFRA-81a/M77) | killed b6117ff |
| tree-hash | @157 sorted | port | P81 sorted (INFRA-81a/M78, INFRA-81a/M174) | killed b6117ff |
| tree-hash | @168 2 MiB | port | P81 2 MiB (INFRA-81a/M79) | killed b6117ff |
| tree-hash | @186 TH-1 | port | P81 TH-1 (INFRA-81a/M80) | killed b6117ff |
| tree-hash | @206 TH-2 | port | P81 TH-2 (INFRA-81a/M81) | killed b6117ff |
| tree-hash | @220 TH-3 | counterpart | `tree-hash` TH-3 | |
| tree-hash | @229 TH-4 | port | P81 TH-4 (INFRA-81a/M82) | killed b6117ff |
| tree-hash | @239 TH-5 | counterpart | `tree-hash` TH-5 | |
| tree-hash | @254 TH-6 | port | P81 TH-6 (INFRA-81a/M83) | killed b6117ff |
| tree-hash | @275 TH-7 | port | P81 TH-7 (INFRA-81a/M84) | killed b6117ff |
| tree-hash | @281 TH-B1 | port | P81 TH-B1 (INFRA-81a/M85) | killed b6117ff |
| tree-hash | @299 TH-R1 | counterpart | `tree-hash` TH-R1 | |
| verify-failures | @193 FV-1 | port | P81 FV-1 (INFRA-81a/M86) | killed b6117ff |
| verify-failures | @207 FV-2 | port | P81 FV-2 (INFRA-81a/M87) | killed b6117ff |
| verify-failures | @222 FV-3 | port | P81 FV-3 (INFRA-81a/M88) | killed b6117ff |
| verify-failures | @237 FV-4 | port | P81 FV-4 (INFRA-81a/M89) | killed b6117ff |
| verify-failures | @255 FV-5 | port | P81 FV-5 (INFRA-81a/M90) | killed b6117ff |
| verify-failures | @266 FV-6 | port | P81 FV-6 (INFRA-81a/M91) | killed b6117ff |
| verify-failures | @277 FV-7 | port | P81 FV-7 (INFRA-81a/M92) | killed b6117ff |
| verify-failures | @313 FV-8 | port | P81 FV-8 (INFRA-81a/M93) | killed b6117ff |
| verify-failures | @330 FV-9 | port | P81 FV-9 (INFRA-81a/M94) | killed b6117ff |
| verify-failures | @361 FV-10 | counterpart | `failures` FV-10 | |
| verify-failures | @400 FV-11 | port | P81 FV-11 (INFRA-81a/M95) | killed b6117ff |
| verify-failures | @405 FV-12 a | counterpart | `failures` FV-12 | |
| verify-failures | @405 FV-12 b | port | P81 FV-12 b (INFRA-81a/M96) | killed b6117ff |
| verify-failures | @446 FV-13 | port | P81 FV-13 (INFRA-81a/M175) | killed b6117ff |
| ticket-gate | @124 untracked then committed | port | P81 untracked then committed (INFRA-81a/M97) | killed b6117ff |
| ticket-gate | @134 untracked excluded | counterpart | `root-and-tree` DR-4 | |
| ticket-gate | @142 byte change stale | counterpart | `stop-hook` GS-3 | |
| ticket-gate | @152 skipped result | port | P81 skipped result (INFRA-81a/M176) | killed b6117ff |
| ticket-gate | @167 ok false | port | P81 ok false (INFRA-81a/M98) | killed b6117ff |
| ticket-gate | @177 GT-1 | counterpart | `stop-hook` GT-1 | |
| ticket-gate | @187 GT-2 | port | P81 GT-2 (INFRA-81a/M99) | killed b6117ff |
| ticket-gate | @198 GT-3 | port | P81 GT-3 (INFRA-81a/M100) | killed b6117ff |
| ticket-gate | @209 GT-4 | project config | guard INFRA-10/M12 on the project's oversize regex | |
| ticket-gate | @217 GT-5 | port | P81 GT-5 (INFRA-81a/M101) | killed b6117ff |
| ticket-gate | @230 GT-M1 | port | P81 GT-M1 (INFRA-81a/M102) | killed b6117ff |
| ticket-gate | @238 GT-M2 | counterpart | `stop-hook` GT-M2 | |
| ticket-gate | @248 GT-M3 | counterpart | `stop-hook` GT-M3 | |
| ticket-gate | @259 GT-M4 | port | P81 GT-M4 (INFRA-81a/M103) | killed b6117ff |
| ticket-gate | @267 GT-M5 | port | P81 GT-M5 (INFRA-81a/M104) | killed b6117ff |
| ticket-gate | @275 GT-M6 | port | P81 GT-M6 (INFRA-81a/M105) | killed b6117ff |
| ticket-gate | @320 GS-1 | counterpart | `stop-hook` GS-1 | |
| ticket-gate | @329 GS-2 | port | P81 GS-2 (INFRA-81a/M106) | killed b6117ff |
| ticket-gate | @339 GS-3 | counterpart | `stop-hook` GS-3 | |
| ticket-gate | @355 GS-4 | port | P81 GS-4 (INFRA-81a/M107) | killed b6117ff |
| ticket-gate | @368 GS-5 | port | P81 GS-5 (INFRA-81a/M108) | killed b6117ff |
| ticket-gate | @387 GS-6 | counterpart | `stop-hook` GS-6 | |
| ticket-gate | @417 FG-1 | port | P81 FG-1 (INFRA-81a/M109) | killed b6117ff |
| ticket-gate | @424 FG-2 | counterpart | `stop-hook-e2e-fu` FG-2 | |
| ticket-gate | @434 FG-3 | counterpart | `stop-hook-e2e-fu` FG-3 | |
| ticket-gate | @440 FG-4 | counterpart | `stop-hook-e2e-fu` FG-5 (control) | |
| ticket-gate | @449 FG-5 | counterpart | `stop-hook-e2e-fu` FG-5 | |
| ticket-gate | @462 FG-6 | port | P81 FG-6 (INFRA-81a/M110) | killed b6117ff |
| ticket-gate | @468 FG-7 | port | P81 FG-7 (INFRA-81a/M111) | killed b6117ff |
| ticket-gate | @477 GS-7 | counterpart | `stop-hook` GS-7 | |
| ticket-gate | @495 GS-8 | counterpart | `stop-hook` GS-8 | |
| ticket-gate | @505 GS-9 | counterpart | `stop-hook` GS-9 | |
| ticket-gate | @514 GS-10 | counterpart | `stop-hook` GS-10 | |
| ticket-gate | @528 GS-11 | port | P81 GS-11 (INFRA-81a/M112) | killed b6117ff |
| ticket-gate | @590 GR-1 | counterpart | `stop-hook` GR-2 (control) | |
| ticket-gate | @597 GR-2 | counterpart | `stop-hook` GR-2 | |
| ticket-gate | @607 GR-3 | counterpart | `stop-hook` GR-3 | |
| ticket-gate | @622 GR-4 | port | P81 GR-4 (INFRA-81a/M113) | killed b6117ff |
| ticket-gate | @635 GR-5 | port | P81 GR-5 (INFRA-81a/M114) | killed b6117ff |
| ticket-gate | @647 GR-6 | port | P81 GR-6 (INFRA-81a/M177) | killed b6117ff |
| ticket-gate | @716 GE-1 | counterpart | `stop-hook-e2e-fu` GE-5 (control) | |
| ticket-gate | @724 GE-2 | counterpart | `stop-hook-e2e-fu` GE-2 | |
| ticket-gate | @760 GE-3 | counterpart | `stop-hook-e2e-fu` GE-3 | |
| ticket-gate | @779 GE-4 | counterpart | `stop-hook-e2e-fu` GE-4 | |
| ticket-gate | @812 GE-5 | counterpart | `stop-hook-e2e-fu` GE-5 | |
| ticket-gate | @830 GE-6 | counterpart | `stop-hook-e2e-fu` GE-6 | |
| ticket-gate | @852 GE-7 | port | P81 GE-7 (INFRA-81a/M115) | killed b6117ff |
| ticket-gate.fail-closed | @97 TG-FC-1 | counterpart | `stop-hook-fail-closed` TG-FC-1a, 1b | |
| ticket-gate.fail-closed | @105 TG-FC-2 | counterpart | `stop-hook-fail-closed` TG-FC-2 | |
| ticket-gate.fail-closed | @113 TG-FC-3 | counterpart | `stop-hook-fail-closed` TG-FC-3 | |
| ticket-gate.fail-closed | @126 TG-FC-4 | port | P81 TG-FC-4 (INFRA-81a/M116) | killed b6117ff |
| ticket-gate.fail-closed | @132 TG-FC-5 | port | P81 TG-FC-5 (INFRA-81a/M117) | killed b6117ff |
| ticket-gate.fail-closed | @138 TG-FC-6 | port | P81 TG-FC-6 (INFRA-81a/M118) | killed b6117ff |
| block-git-push.fail-closed | @23 BG-FC-1 | counterpart | `push-guard-fail-closed` BG-FC-1a, 1b | |
| block-git-push.fail-closed | @62 BG-FC-2 a | counterpart | `push-guard-fail-closed` BG-FC-1a | |
| block-git-push.fail-closed | @62 BG-FC-2 b | port | P81 BG-FC-2 b (INFRA-81a/M119) | killed b6117ff |
| block-git-push.fail-closed | @79 BG-FC-3 | counterpart | `push-guard-fail-closed` BG-FC-3 | |
| move-check | @53 MC-1 | counterpart | `move-proof` MP-1 | |
| move-check | @58 MC-2 | port | P81 MC-2 (INFRA-81a/M178, INFRA-81a/M179) | killed b6117ff |
| move-check | @80 MC-3 | counterpart | `move-proof` MP-3 | |
| move-check | @99 MC-4 | counterpart | `move-proof` MP-4 | |
| move-check | @107 MC-5 | port | P81 MC-5 (INFRA-81a/M120) | killed b6117ff |
| move-check | @121 MC-6 | port | P81 MC-6 (INFRA-81a/M121) | killed b6117ff |
| move-check | @133 MC-7 | port | P81 MC-7 (INFRA-81a/M122) | killed b6117ff |
| move-check | @154 MC-8 | port | P81 MC-8 (INFRA-81a/M123) | killed b6117ff |
| move-check | @164 MC-10 | port | P81 MC-10 (INFRA-81a/M124) | killed b6117ff |
| move-check | @178 MC-10b | port | P81 MC-10b (INFRA-81a/M125) | killed b6117ff |
| move-check | @187 MC-11 | port | P81 MC-11 (INFRA-81a/M126) | killed b6117ff |
| move-check | @194 MC-9 | counterpart | `cli` CL-10 | |
| move-check | @238 MC-R1 | counterpart | `move-proof` MP-R1 | |
| move-check | @245 MC-R2 | port | P81 MC-R2 (INFRA-81a/M127) | killed b6117ff |
| follow-ups | @69 L-1 | port | P81 L-1 (INFRA-81a/M180, INFRA-81a/M181, INFRA-81a/M182) | killed b6117ff |
| follow-ups | @121 L-2 | port | P81 L-2 (INFRA-81a/M128) | killed b6117ff |
| follow-ups | @139 L-3 | port | P81 L-3 (INFRA-81a/M129) | killed b6117ff |
| follow-ups | @166 L-4 | port | P81 L-4 (INFRA-81a/M183) | killed b6117ff |
| follow-ups | @180 L-5 | port | P81 L-5 (INFRA-81a/M130) | killed b6117ff |
| follow-ups | @201 C-1 | port | P81 C-1 (INFRA-81a/M131) | killed b6117ff |
| follow-ups | @232 C-2 | port | P81 C-2 (INFRA-81a/M132) | killed b6117ff |
| follow-ups | @255 C-3 | port | P81 C-3 (INFRA-81a/M133) | killed b6117ff |
| follow-ups | @267 C-4 | port | P81 C-4 (INFRA-81a/M134) | killed b6117ff |
| follow-ups | @300 C-5 a | counterpart | `fu-register` C-5 | |
| follow-ups | @300 C-5 b | port | P81 C-5 b (INFRA-81a/M135) | killed b6117ff |
| follow-ups | @326 C-6 | port | P81 C-6 (INFRA-81a/M136) | killed b6117ff |
| follow-ups | @343 C-7 | port | P81 C-7 (INFRA-81a/M137) | killed b6117ff |
| check-follow-ups | @31 K-0 | project config | the project's real register | |
| check-follow-ups | @44 clean folder | port | P81 clean folder (INFRA-81a/M184) | killed b6117ff |
| check-follow-ups | @51 K-1 a | counterpart | `fu-check` K-1 | |
| check-follow-ups | @51 K-1 b | port | P81 K-1 b (INFRA-81a/M138) | killed b6117ff |
| check-follow-ups | @60 K-2 | port | P81 K-2 (INFRA-81a/M139) | killed b6117ff |
| check-follow-ups | @70 K-3 | counterpart | `fu-check` K-3 | |
| check-follow-ups | @83 K-4 | counterpart | `fu-check` K-4a, K-4b | |
| check-follow-ups | @96 K-5 a | counterpart | `fu-check` K-5 | |
| check-follow-ups | @96 K-5 b | port | P81 K-5 b (INFRA-81a/M140) | killed b6117ff |
| check-follow-ups | @105 K-6 | counterpart | `fu-check` K-6 | |
| check-follow-ups | @112 K-7 | port | P81 K-7 (INFRA-81a/M185) | killed b6117ff |
| check-module-size | @63 MS-1 | counterpart | `module-size` MZ-1a, MZ-1b | |
| check-module-size | @76 MS-2 | counterpart | `module-size` MZ-2 | |
| check-module-size | @97 MS-3 | counterpart | `module-size` MZ-3 | |
| check-module-size | @120 MS-4 a | project config | guard INFRA-40/M4 on the project's testRe and roots | |
| check-module-size | @120 MS-4 b | port | P81 MS-4 b (INFRA-81a/M141) | killed b6117ff |
| check-module-size | @142 MS-5 | port | P81 MS-5 (INFRA-81a/M142) | killed b6117ff |
| check-module-size | @148 MS-6 a | port | P81 MS-6 a (INFRA-81a/M186) | killed b6117ff |
| check-module-size | @148 MS-6 b | port | P81 MS-6 b (INFRA-81a/M143) | killed b6117ff |
| check-module-size | @167 MS-7 | counterpart | `module-size` MZ-7 | |
| check-module-size | @206 MS-8 a | counterpart | `module-size` MZ-8 | |
| check-module-size | @206 MS-8 b | port | P81 MS-8 b (INFRA-81a/M144) | killed b6117ff |
| check-module-size | @238 MS-9 | port | P81 MS-9 (INFRA-81a/M145) | killed b6117ff |
| check-module-size | @263 MS-9b | port | P81 MS-9b (INFRA-81a/M146) | killed b6117ff |
| check-module-size | @279 MS-10 | project config | the project's tree against its baseline | |
| check-module-size | @285 MS-W | project config | package.json check chain | |
| check-skill-refs | @44 SR-1 | counterpart | `skill-refs` SR-1 | |
| check-skill-refs | @63 SR-2 a | counterpart | `skill-refs` SR-2 | |
| check-skill-refs | @63 SR-2 b | port | P81 SR-2 b (INFRA-81a/M147) | killed b6117ff |
| check-skill-refs | @127 SR-3 a | counterpart | `skill-refs` SR-3 | |
| check-skill-refs | @127 SR-3 b | project config | the project's note text naming its ticket | |
| check-skill-refs | @158 SR-4 | port | P81 SR-4 (INFRA-81a/M148) | killed b6117ff |
| check-skill-refs | @174 SR-5 | port | P81 SR-5 (INFRA-81a/M149) | killed b6117ff |
| check-skill-refs | @188 SR-6 | project config | the project's tree | |
| check-skill-refs | @197 SR-7 | port | P81 SR-7 (INFRA-81a/M150) | killed b6117ff |
| check-skill-refs | @204 SR-W | project config | package.json check chain | |
