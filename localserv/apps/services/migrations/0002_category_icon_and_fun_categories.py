from django.db import migrations, models

# (name, slug, icon, description). Safe to run on a database that already has some of these:
# a category is matched by slug (or name) and only created or given its icon, never duplicated.
FUN_CATEGORIES = [
    ("Game Nights", "game-nights", "🎲", "Board games, cards and good-natured trash talk."),
    ("Karaoke & Open Mic", "karaoke-open-mic", "🎤", "Sing your heart out, or just cheer on the brave ones."),
    ("Movie Nights", "movie-nights", "🎬", "Cinema trips, screenings and cosy watch parties."),
    ("Food Crawls", "food-crawls", "🍜", "Hop between the best spots and taste everything."),
    ("Cooking Together", "cooking-together", "🍳", "Cook, learn a new dish and eat what you made."),
    ("Coffee & Chill", "coffee-chill", "☕", "Slow conversations over a good cup."),
    ("Beach Days", "beach-days", "🏖️", "Sun, sand, music and a ball to kick around."),
    ("Hiking & Nature", "hiking-nature", "🥾", "Trails, viewpoints and fresh air."),
    ("Picnics & Parks", "picnics-parks", "🧺", "Blankets, snacks and an easy afternoon outside."),
    ("Dance & Parties", "dance-parties", "💃", "Dance classes, house parties and DJ nights."),
    ("Live Music & Concerts", "live-music-concerts", "🎶", "Gigs, jam sessions and live bands."),
    ("Sports & Fitness", "sports-fitness", "⚽", "Pickup football, runs, gym buddies and more."),
    ("Book Club", "book-club", "📚", "Read, swap books and argue about the ending."),
    ("Art & Paint Nights", "art-paint-nights", "🎨", "Paint, craft and make something together."),
    ("Photography Walks", "photography-walks", "📸", "Explore the city with a camera and good company."),
    ("Road Trips & Day Trips", "road-trips-day-trips", "🚗", "Pile in the car and go somewhere new."),
    ("Trivia & Quiz Nights", "trivia-quiz-nights", "🧠", "Team up, show off what you know."),
    ("Gaming & Esports", "gaming-esports", "🎮", "Console nights, tournaments and co-op sessions."),
    ("Study & Co-working", "study-co-working", "📖", "Quiet company while you both get things done."),
    ("Pet Playdates", "pet-playdates", "🐶", "Dogs, cats and the people who adore them."),
    ("Wellness & Yoga", "wellness-yoga", "🧘", "Stretch, breathe and reset with others."),
    ("Language Exchange", "language-exchange", "🗣️", "Practice a language and teach your own."),
    ("Comedy Nights", "comedy-nights", "😂", "Stand-up, improv and a lot of laughing."),
    ("Thrift & Fashion", "thrift-fashion", "🛍️", "Thrift runs, style swaps and shopping buddies."),
    ("Volunteering & Giving Back", "volunteering-giving-back", "🤝", "Do some good together in your community."),
    ("Tech & Startup Meetups", "tech-startup-meetups", "💻", "Meet builders, share ideas and swap contacts."),
]


def add_fun_categories(apps, schema_editor):
    ServiceCategory = apps.get_model("services", "ServiceCategory")
    for name, slug, icon, description in FUN_CATEGORIES:
        existing = ServiceCategory.objects.filter(slug=slug).first() or ServiceCategory.objects.filter(name=name).first()
        if existing:
            if not existing.icon:
                existing.icon = icon
                existing.save(update_fields=["icon"])
            continue
        ServiceCategory.objects.create(name=name, slug=slug, icon=icon, description=description)


def remove_fun_categories(apps, schema_editor):
    # Only removes the ones nobody is using yet, so reversing can never delete a listing's category.
    ServiceCategory = apps.get_model("services", "ServiceCategory")
    ServiceCategory.objects.filter(slug__in=[c[1] for c in FUN_CATEGORIES], services__isnull=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("services", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="servicecategory",
            name="icon",
            field=models.CharField(blank=True, default="", max_length=8),
        ),
        migrations.RunPython(add_fun_categories, remove_fun_categories),
    ]
