# Releasing

Merging a pull request never creates a version. `main` is the working branch and
every pull request goes there. A version is cut when the maintainer decides, from
whatever `main` has at that moment, so one version usually carries several pull
requests.

## Release notes

Nobody edits a changelog by hand. When a version is published, GitHub writes its
notes from the pull requests merged since the previous tag, grouped by label
(`.github/release.yml`):

| Label | Section of the notes |
| --- | --- |
| `breaking change` | Breaking changes |
| `enhancement` | New features |
| `bug` | Bug fixes |
| `translation` | Translations |
| `documentation` | Documentation |
| `dependencies`, `github_actions` | Dependencies |
| any other label, or none | Other changes |
| `ignore-for-release` | left out |

That makes the pull request title the line people read: one sentence, in plain
words, about what changes for whoever runs Brambit. When an installation has to do
something after upgrading (a renamed setting, a reinstall), the pull request gets
the `breaking change` label and its description says what to do; that text goes at
the top of the notes of the version.

Versions up to 0.2.24 have their notes in [CHANGELOG.md](../CHANGELOG.md).

## Cutting a version

1. *Version bump.* A pull request to `main` titled `Release X.Y.Z`, labeled
   `ignore-for-release`, changes the version in `package.json`,
   `package-lock.json`, `install.sh` and `install.ps1`. Breaking changes since the
   last tag raise the minor version while Brambit is 0.x; anything else raises the
   patch version.
2. *Release candidate.* Create the `rc` branch from `main`:
   `git push origin origin/main:refs/heads/rc`. CI runs on it, and a test
   installation runs `rc` until the version is out. Pull requests keep going to
   `main` in the meantime without touching what is being tested.
3. *Fixes during the test.* A problem found in `rc` is fixed by a pull request to
   `main`, and the merged commit is then cherry-picked into `rc`.
4. *Publish.* When `rc` is approved:
   `gh release create vX.Y.Z --target rc --generate-notes --notes-start-tag <previous tag>`.
   This creates the tag on `rc` and the release with the generated notes; add the
   upgrade instructions of any breaking change at the top. Then delete `rc`.

Apps that use Brambit pin a tag in their `package.json` (`brambit#vX.Y.Z`) and move
to the new one on purpose.

## Urgent fix between versions

When a fix can't wait for the next version, it is merged into `main` first. Then
create `hotfix-rc` from the last tag, cherry-pick the fix into it, commit the patch
version bump there, test it, publish with
`gh release create vX.Y.Z --target hotfix-rc --generate-notes --notes-start-tag <last tag>`
and delete `hotfix-rc`.
