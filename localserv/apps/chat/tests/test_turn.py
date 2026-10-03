from apps.chat.turn import build_turn_credentials


def test_credentials_match_coturn_scheme():
    # Expected value computed independently:
    #   echo -n "1700003600:42" | openssl dgst -sha1 -hmac test-secret -binary | base64
    username, credential = build_turn_credentials(42, "test-secret", ttl=3600, now=1_700_000_000)
    assert username == "1700003600:42"
    assert credential == "JBICRyprGyCL4OlcL1JiNxUl4Qw="


def test_credentials_expire_with_ttl():
    username, _ = build_turn_credentials(1, "s", ttl=60, now=1000)
    assert username.startswith("1060:")
