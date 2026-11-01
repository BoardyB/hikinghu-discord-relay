# Privacy Policy

**App:** hikinghu-relay (a Reddit Devvit app)
**Developer:** [Balazs Bordas]
**Contact:** [ https://www.reddit.com/user/boardyb/ ]
**Last updated:** [2026. 11. 01.]

hikinghu-relay copies new posts from a Reddit community to a Discord channel chosen by that community's moderators.
This policy explains what data the app handles. It is meant to be short and literal: it describes what the app
actually does.

## What the app does with data

When a new post is created in a subreddit where the app is installed, Reddit notifies the app. The app uses only:

- the post's ID, title and link (permalink), and
- the name and ID of the subreddit.

It then sends the following to the Discord webhook that the subreddit's moderators configured:

- the post title (as the Discord thread name, shortened to 90 characters),
- a link to the post, and
- the text "New post on r/<subreddit>".

The app does **not** use, store or forward post bodies, comments, images, usernames, or any other information about
Reddit users, even where Reddit includes it in the notification.

## What is stored

| Data | Where | How long |
| --- | --- | --- |
| Post IDs of posts already relayed (to avoid duplicates) | Reddit's app storage for the installation | 30 days, then deleted automatically |
| A marker that a failure notice was sent to the moderators | Reddit's app storage for the installation | 24 hours |
| The Discord webhook URL | The app's settings for the subreddit, kept by Reddit | Until the moderators change or clear it, or the app is uninstalled |
| Operational logs: post IDs, subreddit names, Discord response codes, error messages | Reddit's logging for the app | According to Reddit's log retention |

The developer does not copy this data elsewhere. The webhook URL is never written to logs, and the app sends it
nowhere except to Discord.

## Who receives data

- **Discord** receives the post title and link, because the moderators asked for the posts to be relayed to their
  channel. Discord's own privacy policy applies to what happens there. Moderators and Discord server administrators
  control who can see the channel and how long threads are kept.
- **The subreddit's moderators** may receive a Modmail message from the app if relaying breaks (for example, when a
  webhook was deleted). It contains a description of the problem and a link to the affected post.
- **Reddit** hosts and runs the app. Reddit's own terms and privacy policy apply to the platform.

No one else receives data. The app has no analytics, advertising, tracking or profiling, and the developer does not
sell or share data.

## Public and restricted communities

The app relays posts of any subreddit where it is installed. In a private or restricted community, moderators
should only point the app at a Discord channel that is as private as the community. Choosing the channel is the
moderators' responsibility.

## Removing data

- **Stop relaying:** moderators can clear the webhook setting (pauses the app) or uninstall the app at any time.
- **A thread in Discord:** threads are controlled by the Discord server's administrators, not by this app. If you want
  a thread about your post removed, ask the community's moderators.
- **Questions or requests about this policy:** contact above.

## Changes

If the app starts handling data differently, this policy will be updated before the change is released, and the
"Last updated" date above will change.
