# Privacy Policy

**App:** hikinghu-relay (a Reddit Devvit app)
**Developer:** [Balazs Bordas]
**Contact:** [ https://www.reddit.com/user/boardyb/ ]
**Last updated:** [2026. 11. 13.]

hikinghu-relay copies new posts from a Reddit community to a Discord channel chosen by that community's moderators.
This policy explains what data the app handles. It is meant to be short and literal: it describes what the app
actually does.

## What the app does with data

When a new post is created in a subreddit where the app is installed, Reddit notifies the app. The app uses only:

- the post's ID, title and link (permalink), and
- the name and ID of the subreddit.

It then creates a post in the Discord forum channel that the subreddit's moderators configured, using the Discord bot they set up, and sends the following:

- the post title (as the Discord thread name, shortened to 90 characters),
- a link to the post, and
- the text "New post on r/<subreddit>".

When a moderator removes a post or marks it as spam, or when a post is deleted, Reddit notifies the app as well. The
app uses only the post's ID, and for a moderator action the kind of action and the link to the post (the link appears
only in the failure Modmail described below). It then deletes the Discord thread it created for that post. These
notifications also contain other details, such as the names of the moderator and of the post's author. The app ignores
them.

The app does **not** use, store or forward post bodies, comments, images, usernames, or any other information about
Reddit users, even where Reddit includes it in the notification.

## What is stored

| Data | Where | How long |
| --- | --- | --- |
| Post IDs of posts already relayed (to avoid duplicates) | Reddit's app storage for the installation | 30 days, then deleted automatically |
| For each relayed post: the ID of its Discord thread (so the thread can be deleted if the post is removed). No title, link or text | Reddit's app storage for the installation | 30 days, or until the thread is deleted |
| A marker that a post was removed (so it is not relayed, or its thread is deleted as soon as it exists). Only the post's ID | Reddit's app storage for the installation | 24 hours |
| A marker that a failure notice was sent to the moderators (one for relaying problems, one for deleting problems) | Reddit's app storage for the installation | 24 hours |
| The Discord bot token and the forum channel ID | The app's settings for the subreddit, kept by Reddit. Reddit shows them to the subreddit's moderators | Until the moderators change or clear them, or the app is uninstalled |
| Operational logs: post IDs, subreddit names, Discord response codes, error messages | Reddit's logging for the app | According to Reddit's log retention |

The developer does not copy this data elsewhere. The bot token is never written to logs or sent in messages, and the
app sends it nowhere except to Discord, as the credential for its requests.

## Who receives data

- **Discord** receives the post title and link, because the moderators asked for the posts to be relayed to their
  channel. When a post is removed or deleted it also receives a request, carrying only the ID of the thread, to
  delete that thread. Every request is made as the moderators' bot and carries its token. Discord's own privacy policy applies to what happens there. Moderators and
  Discord server administrators control who can see the channel and how long threads are kept.
- **The subreddit's moderators** may receive a Modmail message from the app if relaying breaks (for example, when the
  bot token was reset) or if a thread could not be deleted. It contains a description of the problem and a link to the
  affected post.
- **Reddit** hosts and runs the app. Reddit's own terms and privacy policy apply to the platform.

No one else receives data. The app has no analytics, advertising, tracking or profiling, and the developer does not
sell or share data.

## Public and restricted communities

The app relays posts of any subreddit where it is installed. In a private or restricted community, moderators
should only point the app at a Discord channel that is as private as the community. Choosing the channel is the
moderators' responsibility.

## Removing data

- **Stop relaying:** moderators can clear the bot token or channel setting (pauses the app) or uninstall the app at any time.
- **A thread in Discord:** when a post is removed or deleted on Reddit, the app deletes its thread automatically.
  Otherwise threads are controlled by the Discord server's administrators, not by this app. If a thread about your post
  is still there, for example because it was created before this feature existed, ask the community's moderators to
  delete it.
- **Questions or requests about this policy:** contact above.

## Changes

If the app starts handling data differently, this policy will be updated before the change is released, and the
"Last updated" date above will change.
