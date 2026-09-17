from app.rag import relevance


def test_relevance_prefers_requested_activity_category():
    culture = relevance("cultura arte", category="cultura", name="Museo d'arte")
    sport = relevance("cultura arte", category="sport", name="Tour in bicicletta")
    assert culture > sport


def test_relevance_is_deterministic_without_query():
    assert relevance("", category="relax") == 0.0
