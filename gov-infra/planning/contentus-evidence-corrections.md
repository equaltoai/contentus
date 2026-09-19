# Evidence citation corrections

A log of rubric-evidence commits whose messages cited the wrong source
object, and the correction each one received. A committed report names the
PARENT of the commit that carries it (`gov_rubric_report.v1` `source.sha`),
so a citation that does not resolve is a reader-facing defect in the
governance record — it claims evidence for a commit that does not exist.

## 2026-08-31 — `ec0dd60a4ac936447ab7cdec997961f074f0ddbd` cites a nonexistent parent

Commit `ec0dd60a4ac936447ab7cdec997961f074f0ddbd`
(`chore(gov): record rubric evidence for 28b4ff8`) carries this body:

> Canonical rubric at 28b4ff8d45e5f0cdb2a1178f4b2f5c1e38a0b02a8:

The object it cites does not exist in this repository:

```
$ git cat-file -e 28b4ff8d45e5f0cdb2a1178f4b2f5c1e38a0b02a8
fatal: Not a valid object name 28b4ff8d45e5f0cdb2a1178f4b2f5c1e38a0b02a8
```

The commit's real parent — the code commit the report actually scanned — is

```
28b4ff89d62531a15f01db27b5c9d262a570f487   (28b4ff8)
```

which resolves, and `git rev-parse ec0dd60^` confirms it is the parent:

```
$ git rev-parse ec0dd60a4ac936447ab7cdec997961f074f0ddbd^
28b4ff89d62531a15f01db27b5c9d262a570f487
```

**Correction.** The bad citation is `28b4ff8d45e5f0cdb2a1178f4b2f5c1e38a0b02a8`
(nonexistent); the correct existing object is
`28b4ff89d62531a15f01db27b5c9d262a570f487`. This file is the signed
follow-up correction: the history is not rewritten (no amend, rebase, or
force-push), and every rubric-evidence commit after this one cites its real
source parent.
