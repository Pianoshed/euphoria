import io
import json
import os
import shutil
import tempfile
from unittest import mock

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from PIL import Image

from apps.square import music, services
from apps.square.models import Status, StatusSlide

from .tests import BASE, SquareBackend

OPENVERSE_TRACK = {
    "id": "0a1b2c3d-1111-2222-3333-444455556666", "title": "Lazy Afternoon", "creator": "Some Artist",
    "license": "by", "license_version": "4.0", "license_url": "https://creativecommons.org/licenses/by/4.0/",
    "url": "https://cdn.example.org/audio/lazy.mp3", "foreign_landing_url": "https://example.org/lazy",
    "duration": 95000, "thumbnail": "https://cdn.example.org/t.jpg",
}


def _img(size=(2400, 1600), fmt="JPEG", orientation=None, name="p.jpg", mode="RGB"):
    base = Image.linear_gradient("L").resize(size)
    im = Image.merge("RGB", (base, base.transpose(Image.FLIP_TOP_BOTTOM), base)) if mode == "RGB" else base.convert(mode)
    buf = io.BytesIO()
    kw = {}
    if orientation:
        ex = Image.Exif()
        ex[0x0112] = orientation
        kw["exif"] = ex
    im.save(buf, format=fmt, **kw)
    ctype = {"JPEG": "image/jpeg", "PNG": "image/png"}[fmt]
    return SimpleUploadedFile(name, buf.getvalue(), content_type=ctype)


def _resp(payload):
    r = mock.Mock()
    r.json.return_value = payload
    r.raise_for_status.return_value = None
    return r


class SlideshowStatus(SquareBackend):
    def setUp(self):
        super().setUp()
        cache.clear()
        p = mock.patch("apps.square.services.purge_in_background")  # its thread fights SQLite in tests
        p.start()
        self.addCleanup(p.stop)
        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, ignore_errors=True)
        ov = override_settings(MEDIA_ROOT=self.media)
        ov.enable()
        self.addCleanup(ov.disable)

    def post(self, files, who="a", **extra):
        if "music" in extra and not isinstance(extra["music"], str):
            extra["music"] = json.dumps(extra["music"])  # multipart can't nest: the app sends music as a JSON string
        return self.cl[who].post(f"{BASE}/statuses/", {"slides": files, **extra}, format="multipart")

    def stored_files(self):
        return [os.path.join(d, f) for d, _, fs in os.walk(self.media) for f in fs]

    # ---------- creating ----------
    def test_creates_slideshow_in_order_with_cover(self):
        r = self.post([_img(), _img(fmt="PNG", name="b.png"), _img(size=(900, 900))], slide_seconds="4", text="trip")
        self.assertEqual(r.status_code, 201, r.content)
        j = r.json()
        self.assertEqual((j["kind"], j["slide_seconds"], j["duration"], j["text"]), ("slideshow", 4, 12, "trip"))
        self.assertEqual(len(j["slides"]), 3)
        self.assertTrue(all(sl["url"].endswith(".webp") for sl in j["slides"]))
        self.assertTrue(j["cover"].endswith(".webp"))
        self.assertIsNone(j["file"])
        self.assertEqual(list(StatusSlide.objects.filter(status_id=j["id"]).values_list("position", flat=True)), [0, 1, 2])

    def test_slides_are_shrunk_webp_and_much_smaller(self):
        src = _img(size=(4000, 3000))
        raw = src.size
        self.post([src, _img()])
        files = self.stored_files()
        slides = [f for f in files if f.endswith(".webp")]
        self.assertEqual(len(slides), 3)  # 2 slides + cover
        biggest = 0
        for f in slides:
            with Image.open(f) as im:
                self.assertEqual(im.format, "WEBP")
                biggest = max(biggest, max(im.size))
            self.assertLess(os.path.getsize(f), raw)
        self.assertLessEqual(biggest, 1280)
        cover = min(slides, key=os.path.getsize)
        with Image.open(cover) as im:
            self.assertLessEqual(max(im.size), 360)

    def test_exif_rotation_applied_and_gps_dropped(self):
        self.post([_img(size=(2000, 1000), orientation=6), _img()])
        first = StatusSlide.objects.get(position=0)
        self.assertGreater(first.height, first.width)  # landscape + "rotate 90" tag -> stored upright (portrait)
        with Image.open(first.file.path) as im:
            self.assertEqual((im.width, im.height), (first.width, first.height))
            self.assertFalse(im.getexif())

    def test_transparent_png_is_flattened_to_white_not_black(self):
        buf = io.BytesIO()
        Image.new("RGBA", (200, 200), (0, 0, 0, 0)).save(buf, format="PNG")
        png = SimpleUploadedFile("t.png", buf.getvalue(), content_type="image/png")
        self.assertEqual(self.post([png, _img()]).status_code, 201)
        with Image.open(StatusSlide.objects.get(position=0).file.path) as im:
            self.assertGreater(sum(im.convert("RGB").getpixel((10, 10))), 700)

    def test_photo_count_limits(self):
        self.assertEqual(self.post([_img()]).status_code, 400)
        self.assertEqual(self.post([_img(size=(100, 100)) for _ in range(9)]).status_code, 400)
        self.assertEqual(self.post([_img(size=(100, 100)) for _ in range(8)]).status_code, 400)  # 8 x 2 s would pass 15 s
        r = self.post([_img(size=(100, 100)) for _ in range(7)])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual((r.json()["slide_seconds"], r.json()["duration"]), (2, 14))  # default shortened to fit 15 s

    def test_whole_show_never_exceeds_15_seconds(self):
        three = lambda: [_img(size=(200, 200)) for _ in range(3)]
        self.assertEqual(self.post(three(), slide_seconds="6").status_code, 400)  # 18 s
        r = self.post(three(), slide_seconds="5")
        self.assertEqual((r.status_code, r.json()["duration"]), (201, 15))
        self.assertEqual(self.post([_img(size=(200, 200)) for _ in range(6)], slide_seconds="3").status_code, 400)  # 18 s

    def test_template_and_canvas_are_stored_and_returned(self):
        r = self.post([_img(size=(200, 200)), _img(size=(200, 200))], template="drift", canvas="frame")
        self.assertEqual(r.status_code, 201, r.content)
        j = r.json()
        self.assertEqual((j["template"], j["canvas"]), ("drift", "frame"))
        listed = {s["id"]: s for s in self.cl["a"].get(f"{BASE}/statuses/").json()}[j["id"]]
        self.assertEqual((listed["template"], listed["canvas"]), ("drift", "frame"))

    def test_template_and_canvas_default_and_reject_unknown(self):
        j = self.post([_img(size=(200, 200)), _img(size=(200, 200))]).json()
        self.assertEqual((j["template"], j["canvas"]), ("fade", "blur"))
        before = Status.objects.count()
        self.assertEqual(self.post([_img(size=(200, 200)), _img(size=(200, 200))], template="confetti").status_code, 400)
        self.assertEqual(self.post([_img(size=(200, 200)), _img(size=(200, 200))], canvas="<script>").status_code, 400)
        self.assertEqual(Status.objects.count(), before)
        self.assertEqual(len(self.stored_files()), 3)  # only the first (valid) show's 2 slides + cover were written

    def test_cover_is_a_square_for_the_round_ring(self):
        self.post([_img(size=(3000, 1000)), _img()])
        with Image.open(Status.objects.get().cover.path) as im:
            self.assertEqual(im.size, (360, 360))

    def test_non_slideshow_has_no_look(self):
        r = self.cl["a"].post(f"{BASE}/statuses/", {"file": _img(size=(300, 300))}, format="multipart")
        self.assertEqual((r.json()["template"], r.json()["canvas"]), (None, None))

    def test_one_bad_photo_stores_nothing(self):
        before = Status.objects.count()
        fake = SimpleUploadedFile("x.jpg", b"not an image at all" * 100, content_type="image/jpeg")
        r = self.post([_img(size=(300, 300)), _img(size=(300, 300)), fake])
        self.assertEqual(r.status_code, 400)
        self.assertEqual(Status.objects.count(), before)
        self.assertEqual(self.stored_files(), [])

    def test_failure_while_saving_removes_files_and_rows(self):
        before = Status.objects.count()
        real = StatusSlide.save
        calls = {"n": 0}

        def boom(self, *a, **k):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("db down")
            return real(self, *a, **k)

        with mock.patch.object(StatusSlide, "save", boom), self.assertRaises(RuntimeError):
            self.cl["a"].post(f"{BASE}/statuses/", {"slides": [_img(size=(300, 300)) for _ in range(3)]}, format="multipart")
        self.assertEqual(Status.objects.count(), before)
        self.assertEqual(self.stored_files(), [])

    def test_bad_slide_seconds_and_mixed_upload_rejected(self):
        self.assertEqual(self.post([_img(size=(200, 200)), _img(size=(200, 200))], slide_seconds="30").status_code, 400)
        r = self.cl["a"].post(f"{BASE}/statuses/", {"slides": [_img(size=(200, 200)), _img(size=(200, 200))],
                                                    "file": _img(size=(200, 200))}, format="multipart")
        self.assertEqual(r.status_code, 400)

    def test_single_photo_status_still_works_and_is_upright(self):
        r = self.cl["a"].post(f"{BASE}/statuses/", {"file": _img(size=(2000, 1000), orientation=6)}, format="multipart")
        self.assertEqual(r.status_code, 201, r.content)
        s = Status.objects.get(pk=r.json()["id"])
        with Image.open(s.file.path) as im:
            self.assertGreater(im.height, im.width)

    # ---------- visibility ----------
    def test_slideshow_visible_only_inside_my_circle(self):
        sid = self.post([_img(size=(300, 300)), _img(size=(300, 300))]).json()["id"]
        seen_by = lambda who: {s["id"]: s for s in self.cl[who].get(f"{BASE}/statuses/").json()}
        self.assertEqual(len(seen_by("b")[sid]["slides"]), 2)   # tagged in a's tree
        self.assertNotIn(sid, seen_by("c"))                      # stranger
        self.assertEqual(self.cl["c"].post(f"{BASE}/statuses/{sid}/react/", {"emoji": "🔥"}, format="json").status_code, 404)

    def test_list_does_not_query_per_slide(self):
        for _ in range(3):
            self.post([_img(size=(200, 200)), _img(size=(200, 200)), _img(size=(200, 200))])
        with self.assertNumQueries(7):  # circle ids (3) + statuses + reactions + slides + seen; flat in slide count
            self.cl["a"].get(f"{BASE}/statuses/")

    # ---------- purge ----------
    def test_purge_deletes_every_slideshow_file(self):
        self.post([_img(size=(300, 300)), _img(size=(300, 300))])
        keep_before = len(self.stored_files())
        self.assertEqual(keep_before, 3)
        Status.objects.update(expires_at=Status.objects.first().created_at)
        services.purge_expired()
        self.assertEqual(self.stored_files(), [])
        self.assertEqual(StatusSlide.objects.count(), 0)

    # ---------- music ----------
    @mock.patch("apps.square.music.requests.get")
    def test_music_is_verified_server_side_and_stored_as_reference(self, get):
        get.return_value = _resp(OPENVERSE_TRACK)
        r = self.post([_img(size=(200, 200)), _img(size=(200, 200))],
                      music='{"provider": "openverse", "id": "%s", "url": "https://evil.example/x.mp3"}' % OPENVERSE_TRACK["id"])
        self.assertEqual(r.status_code, 201, r.content)
        m = r.json()["music"]
        self.assertEqual(m["url"], OPENVERSE_TRACK["url"])  # canonical URL from the provider, never the client's
        self.assertEqual(m["title"], "Lazy Afternoon")
        self.assertIn("CC BY 4.0", m["credit"])
        self.assertNotIn("provider", m)
        self.assertEqual(len(self.stored_files()), 3)       # no audio stored: 2 slides + cover only

    @mock.patch("apps.square.music.requests.get")
    def test_non_commercial_or_nodervs_tracks_refused(self, get):
        for lic in ("by-nc", "by-nd", "by-sa", "by-nc-sa"):
            cache.clear()
            get.return_value = _resp({**OPENVERSE_TRACK, "license": lic})
            r = self.post([_img(size=(200, 200)), _img(size=(200, 200))],
                          music={"provider": "openverse", "id": OPENVERSE_TRACK["id"]})
            self.assertEqual(r.status_code, 400, lic)
        self.assertEqual(Status.objects.filter(kind="slideshow").count(), 0)
        self.assertEqual(self.stored_files(), [])

    @mock.patch("apps.square.music.requests.get")
    def test_music_provider_down_gives_friendly_error_and_stores_nothing(self, get):
        import requests
        get.side_effect = requests.ConnectionError("down")
        r = self.post([_img(size=(200, 200)), _img(size=(200, 200))],
                      music={"provider": "openverse", "id": OPENVERSE_TRACK["id"]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("busy", str(r.json()))
        self.assertEqual(self.stored_files(), [])

    def test_bad_music_input_rejected(self):
        two = lambda: [_img(size=(200, 200)), _img(size=(200, 200))]
        for bad in ({"provider": "napster", "id": "1"}, {"provider": "openverse", "id": "../../etc"},
                    {"provider": "jamendo", "id": "1"}, ["x"], "garbage"):  # jamendo is off without a client id
            self.assertEqual(self.post(two(), music=bad).status_code, 400, bad)
        r = self.cl["a"].post(f"{BASE}/statuses/", {"text": "hi", "music": {"provider": "openverse", "id": "1"}}, format="json")
        self.assertEqual(r.status_code, 400)  # music needs a slideshow

    @mock.patch("apps.square.music.requests.get")
    def test_music_search_filters_and_caches(self, get):
        get.return_value = _resp({"results": [
            OPENVERSE_TRACK,
            {**OPENVERSE_TRACK, "id": "nc", "license": "by-nc"},
            {**OPENVERSE_TRACK, "id": "http", "url": "http://insecure.example/a.mp3"},
            {**OPENVERSE_TRACK, "id": "long", "duration": 3_600_000},
            {**OPENVERSE_TRACK, "id": "cc0", "license": "cc0", "license_version": "1.0"},
        ]})
        r = self.cl["a"].get(f"{BASE}/music/", {"q": "lazy"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual([t["id"] for t in r.json()["results"]], [OPENVERSE_TRACK["id"], "cc0"])
        self.cl["a"].get(f"{BASE}/music/", {"q": "lazy"})
        self.assertEqual(get.call_count, 1)  # second search served from cache
        params = get.call_args.kwargs["params"]
        self.assertEqual(params["license_type"], "commercial,modification")
        self.assertEqual(params["category"], "music")

    @mock.patch("apps.square.music.requests.get")
    def test_music_search_survives_provider_outage(self, get):
        import requests
        get.side_effect = requests.Timeout()
        r = self.cl["a"].get(f"{BASE}/music/", {"q": "lazy"})
        self.assertEqual((r.status_code, r.json()["results"]), (200, []))
        self.assertEqual(self.cl["a"].get(f"{BASE}/music/", {"q": "x"}).json()["results"], [])  # too short: no call

    @override_settings(JAMENDO_CLIENT_ID="abc")
    @mock.patch("apps.square.music.requests.get")
    def test_jamendo_license_taken_from_cc_url(self, get):
        row = {"id": "7", "name": "Song", "artist_name": "Band", "audio": "https://prod.jamendo.test/7.mp3",
               "duration": 120, "shareurl": "https://jamendo.test/7", "image": "https://jamendo.test/i.jpg"}
        get.return_value = _resp({"results": [
            {**row, "license_ccurl": "http://creativecommons.org/licenses/by/3.0/"},
            {**row, "id": "8", "license_ccurl": "http://creativecommons.org/licenses/by-nc-sa/3.0/"},
        ]})
        out = music.search("song", "jamendo")
        self.assertEqual([t["id"] for t in out], ["7"])
        self.assertIn("CC BY 3.0", out[0]["credit"])
