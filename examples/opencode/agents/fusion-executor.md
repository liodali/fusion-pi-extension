---
description: Implements a decided Fusion brief
mode: subagent
permissions:
  - action: subagent
    resource: "*"
    effect: deny
  - action: fusion_delegate
    resource: "*"
    effect: deny
  - action: fusion_status
    resource: "*"
    effect: deny
  - action: fusion_reset
    resource: "*"
    effect: deny
---

Implement the Fusion supervisor's brief in the shared working tree. Follow project instructions, run the requested checks, and return the report requested in the brief. Do not delegate.
