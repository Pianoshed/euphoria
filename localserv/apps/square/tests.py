from django.contrib.auth import get_user_model
from rest_framework.test import APIClient, APITestCase

U = get_user_model()
BASE = "/api/square"


class SquareBackend(APITestCase):
    def setUp(self):
        def mk(n):
            # display_name lives on Profile (auto-created by a post_save signal), not on User.
            u = U.objects.create_user(email=f"{n}@example.com", username=f"user_{n}", password="a-strong-password-1")
            u.mark_email_verified()          # status -> ACTIVE, required by IsActiveAccount
            u.profile.display_name = n.title()
            u.profile.save(update_fields=["display_name"])
            u.key = n                        # short handle used by the tests below ("a".."g")
            return u
        self.me, self.b, self.c, self.d, self.e, self.f, self.g = (mk(n) for n in "abcdefg")
        def as_(u):
            cl = APIClient(); cl.force_authenticate(u); return cl
        self.cl = {u.key: as_(u) for u in (self.me, self.b, self.c, self.d, self.e, self.f, self.g)}
        # me owns a tree with b; d owns a tree that tags me and e; f owns a tree with g (unrelated to me)
        r = self.cl["a"].post(f"{BASE}/trees/", {"title": "Mine", "members": [str(self.b.id)],
                                                 "labels": {str(self.b.id): "family"}}, format="json")
        self.assertEqual(r.status_code, 201, r.content); self.mine = r.json()
        self.cl["d"].post(f"{BASE}/trees/", {"title": "Dees", "members": [str(self.me.id), str(self.e.id)]}, format="json")
        self.cl["f"].post(f"{BASE}/trees/", {"title": "Eff", "members": [str(self.g.id)]}, format="json")
        self.st = {}
        for u in (self.me, self.b, self.c, self.d, self.e, self.f, self.g):
            r = self.cl[u.key].post(f"{BASE}/statuses/", {"text": f"hi {u.key}"}, format="multipart")
            self.assertEqual(r.status_code, 201, r.content); self.st[u.key] = r.json()["id"]

    # ---------- statuses: friend-tree people only ----------
    def test_statuses_only_from_my_trees(self):
        names = {s["text"] for s in self.cl["a"].get(f"{BASE}/statuses/").json()}
        self.assertEqual(names, {"hi a", "hi b", "hi d", "hi e"})   # me, my member, the owner who tagged me, his other member

    def test_stranger_sees_only_self(self):
        names = {s["text"] for s in self.cl["c"].get(f"{BASE}/statuses/").json()}
        self.assertEqual(names, {"hi c"})

    def test_member_sees_owner_and_cotagged(self):
        names = {s["text"] for s in self.cl["b"].get(f"{BASE}/statuses/").json()}
        self.assertEqual(names, {"hi a", "hi b"})

    def test_cannot_react_to_outsider(self):
        self.assertEqual(self.cl["a"].post(f"{BASE}/statuses/{self.st['c']}/react/", {"emoji": "🔥"}, format="json").status_code, 404)
        self.assertEqual(self.cl["a"].post(f"{BASE}/statuses/{self.st['b']}/react/", {"emoji": "🔥"}, format="json").status_code, 200)

    def test_trending_scoped(self):
        self.cl["g"].post(f"{BASE}/statuses/{self.st['f']}/react/", {"emoji": "😂"}, format="json")  # invisible to me
        self.cl["b"].post(f"{BASE}/statuses/{self.st['a']}/react/", {"emoji": "🔥"}, format="json")  # visible
        t = self.cl["a"].get(f"{BASE}/trending/").json()
        self.assertEqual([s["text"] for s in t["statuses"]], ["hi a"])
        self.assertEqual(t["emoji"], ["🔥"])

    def test_visibility_follows_trees(self):
        self.cl["a"].delete(f"{BASE}/trees/{self.mine['id']}/")
        self.assertNotIn("hi b", {s["text"] for s in self.cl["a"].get(f"{BASE}/statuses/").json()})
        self.cl["a"].post(f"{BASE}/trees/", {"title": "again", "members": [str(self.c.id)]}, format="json")
        self.assertIn("hi c", {s["text"] for s in self.cl["a"].get(f"{BASE}/statuses/").json()})

    def test_thoughts_unchanged(self):
        self.cl["c"].post(f"{BASE}/thoughts/", {"text": "open to all"}, format="json")
        self.assertEqual(len(self.cl["a"].get(f"{BASE}/thoughts/").json()), 1)

    # ---------- labels ----------
    def test_owner_sees_names_member_sees_only_own_spot(self):
        t = next(t for t in self.cl["a"].get(f"{BASE}/trees/").json() if t["title"] == "Mine")
        self.assertEqual(t["members"][0]["label"], "family")
        self.assertEqual(t["members"][0]["name"], "B")
        self.cl["a"].patch(f"{BASE}/trees/{self.mine['id']}/", {
            "members": [str(self.b.id), str(self.c.id)], "labels": {str(self.c.id): "work"}}, format="json")
        tb = next(t for t in self.cl["b"].get(f"{BASE}/trees/").json() if t["title"] == "Mine")
        by_id = {m["id"]: m for m in tb["members"]}
        me, other = by_id[str(self.b.id)], by_id[str(self.c.id)]
        self.assertEqual((me["name"], me["label"]), ("B", "family"))        # my own spot: named, with my tier
        self.assertTrue(other["hidden"]); self.assertEqual(other["name"], "")  # everyone else: anonymous
        self.assertEqual(other["label"], "work")                              # but the skeleton keeps its shape
        self.assertNotIn("C", str(tb["members"]))
        self.assertFalse(tb["mine"])

    def test_tagged_friend_can_leave_but_not_delete(self):
        r = self.cl["b"].delete(f"{BASE}/trees/{self.mine['id']}/")
        self.assertEqual(r.status_code, 204)
        self.assertEqual(self.cl["b"].get(f"{BASE}/trees/{self.mine['id']}/").status_code, 404)  # gone for them
        owner_view = next(t for t in self.cl["a"].get(f"{BASE}/trees/").json() if t["title"] == "Mine")
        self.assertEqual(owner_view["members"], [])  # the tree itself survives

    def test_default_label_is_friends(self):
        r = self.cl["a"].post(f"{BASE}/trees/", {"title": "plain", "members": [str(self.c.id)]}, format="json").json()
        self.assertEqual(r["members"][0]["label"], "friends")

    def test_patch_labels_only(self):
        r = self.cl["a"].patch(f"{BASE}/trees/{self.mine['id']}/", {"labels": {str(self.b.id): "work"}}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["members"][0]["label"], "work")
        self.assertEqual(len(r.json()["members"]), 1)   # members untouched

    def test_patch_add_member_with_label(self):
        r = self.cl["a"].patch(f"{BASE}/trees/{self.mine['id']}/", {
            "members": [str(self.b.id), str(self.c.id)], "labels": {str(self.c.id): "school", str(self.b.id): "besties"}}, format="json").json()
        got = {m["name"]: m["label"] for m in r["members"]}
        self.assertEqual(got, {"B": "besties", "C": "school"})

    def test_bad_labels_rejected(self):
        for bad in ({"x": "enemies"}, ["family"], "nonsense"):
            r = self.cl["a"].patch(f"{BASE}/trees/{self.mine['id']}/", {"labels": bad}, format="json")
            self.assertEqual(r.status_code, 400, bad)
        r = self.cl["a"].post(f"{BASE}/trees/", {"title": "t", "members": [str(self.c.id)], "labels": {str(self.c.id): "nope"}}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_unknown_ids_in_labels_ignored(self):
        r = self.cl["a"].patch(f"{BASE}/trees/{self.mine['id']}/", {"labels": {"not-a-uuid": "work", str(self.c.id): "work"}}, format="json")
        self.assertEqual(r.status_code, 200); self.assertEqual(r.json()["members"][0]["label"], "family")  # unchanged

    def test_member_cannot_relabel(self):
        r = self.cl["b"].patch(f"{BASE}/trees/{self.mine['id']}/", {"labels": {str(self.b.id): "family"}}, format="json")
        self.assertEqual(r.status_code, 404)

    def test_labels_as_json_string_multipart(self):
        import json
        r = self.cl["a"].patch(f"{BASE}/trees/{self.mine['id']}/", {"labels": json.dumps({str(self.b.id): "partner"})}, format="multipart")
        self.assertEqual(r.status_code, 200, r.content); self.assertEqual(r.json()["members"][0]["label"], "partner")

    # ---------- seen statuses ----------
    def test_seen_is_saved_per_person(self):
        sid = self.st["b"]
        pick = lambda who: next(s for s in self.cl[who].get(f"{BASE}/statuses/").json() if s["id"] == sid)
        self.assertFalse(pick("a")["seen"])
        self.assertEqual(self.cl["a"].post(f"{BASE}/statuses/{sid}/seen/").status_code, 204)
        self.assertEqual(self.cl["a"].post(f"{BASE}/statuses/{sid}/seen/").status_code, 204)  # idempotent
        self.assertTrue(pick("a")["seen"])
        self.assertTrue(pick("b")["seen"])  # your own status always counts as seen

    def test_cannot_mark_status_outside_my_trees(self):
        self.assertEqual(self.cl["a"].post(f"{BASE}/statuses/{self.st['f']}/seen/").status_code, 404)
