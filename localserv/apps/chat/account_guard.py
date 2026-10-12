"""Close a user's open WebSockets the moment their account stops being ACTIVE.

Every socket checks `status == ACTIVE` only once, when it connects. Without this, a user who is suspended
or banned while a chat socket is open could keep sending and receiving until the socket happened to drop
(the REST API already refuses them immediately). Each socket also joins a per-user group; the User
post_save signal (apps.accounts.signals) sends `account.closed` to it when the status changes.
"""
CLOSE_ACCOUNT_NOT_ACTIVE = 4403


def account_group(user_id) -> str:
    return f"account_{user_id}"


class AccountCloseMixin:
    async def join_account_group(self, user) -> None:
        self._account_group = account_group(user.id)
        await self.channel_layer.group_add(self._account_group, self.channel_name)

    async def leave_account_group(self) -> None:
        group = getattr(self, "_account_group", None)
        if group:
            await self.channel_layer.group_discard(group, self.channel_name)

    async def account_closed(self, event):
        await self.close(code=CLOSE_ACCOUNT_NOT_ACTIVE)
