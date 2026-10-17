# Nortia AI Digital Employee Connector

A small local connector that lets **your own Claude** collect new applicants'
resumes from **your own** hiring-platform account and send them into **your**
Nortia workspace. It runs on your computer as a local MCP server for Claude
Desktop; nothing is installed on Nortia's side.

Resumes arrive in Nortia → AI Digital Employee → Resume. When your workspace
turns auto-assign on, a resume goes to its job automatically: first by the
platform posting linked on the job's page, then by an exact job title match.
The rest wait there for you to assign or close.

## Requirements

- Node.js 20 or newer
- A paid Claude plan and Claude Desktop (the **Code** tab)
- macOS, or Windows 10 or 11
- A Nortia workspace with AI Digital Employee turned on

## Install

Open **Nortia → AI Digital Employee → Connect**. That page generates install
instructions for your workspace; paste them into a new session in Claude
Desktop's Code tab and Claude sets everything up, including a daily scheduled
run. This repository deliberately carries no install steps of its own.

To stop: tell Claude "Disconnect Nortia from this computer".

## Privacy

- Resume files and your Hiredly password never pass through the AI. Resumes are
  downloaded and sent to Nortia inside the connector process, in memory only,
  and are never written to disk.
- Your Hiredly password is typed into a password box on your screen and stored
  in your Mac keychain or Windows Credential Manager; Claude only sees whether
  it was saved.
- Claude only sees counts (how many resumes were sent, matched or skipped) and a
  status sentence — never candidate names, emails or phone numbers.
- Your Nortia connector key passes through Claude once, when you paste the
  install instructions. It can only send resumes to your own workspace, and an
  admin can revoke it at any time in Nortia → AI Digital Employee → Keys.
- So your admin can tell which computer a key is on, the connector sends this
  computer's name, your user name on it and its serial number with each request;
  Nortia keeps them with the key and records the internet address each resume
  came from.
- Each run also sends your Hiredly job list (job id, title, open or closed,
  applicant count) so your team can link postings to Nortia jobs. It sends no
  candidate details with it.
- When an application you already sent is rejected, offered or blacklisted on
  Hiredly, the connector tells Nortia, which closes its waiting copy. To catch
  these, about once a day a run reads every application in your fetch window
  instead of stopping at the ones Nortia already has.

## Roadmap

- Hiredly — available
- JobStreet — browser-driven, planned
- Windows — available

## License

Source-available; see [LICENSE](LICENSE). The license text is pending legal
review.
