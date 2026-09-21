from app.legend_parser import (
    canonicalize_mard_code,
    collapse_unique_candidates,
    compact_pair_candidates,
    parse_legend_lines,
)


VALID_CODES = frozenset(
    {
        "A3",
        "A10",
        "B11",
        "F11",
        "G8",
        "H7",
        "H16",
        "M6",
    }
)


def test_canonicalizes_only_safe_palette_backed_variants() -> None:
    assert canonicalize_mard_code(" h07 ", VALID_CODES) == "H7"
    assert canonicalize_mard_code("A 03", VALID_CODES) == "A3"
    assert canonicalize_mard_code("O8", VALID_CODES) is None
    assert canonicalize_mard_code("Z99", VALID_CODES) is None


def test_parses_realistic_mixed_legend_rows_without_coordinates_or_titles() -> None:
    lines = [
        "Mard(303) 1 2 3 4 5 6 7 8",
        "F11 (58)   G08（28）  H16 56",
        "A10: 301 / B11 [33] / fake Z99 (12)",
        "watermark 676836178",
    ]

    candidates = parse_legend_lines(lines, VALID_CODES)

    assert [(item.code, item.quantity) for item in candidates] == [
        ("F11", 58),
        ("G8", 28),
        ("H16", 56),
        ("A10", 301),
        ("B11", 33),
    ]


def test_keeps_conflicting_ocr_quantities_for_human_review() -> None:
    candidates = parse_legend_lines(["F11 58", "F11 (58)", "H16 56", "H16 55"], VALID_CODES)

    materials, conflicts = collapse_unique_candidates(candidates)

    assert materials == {"F11": 58}
    assert conflicts == frozenset({"H16"})


def test_rejects_zero_and_does_not_guess_ocr_character_substitutions() -> None:
    candidates = parse_legend_lines(["F11 (0) GOB (28) HI6 (46) M06 7"], VALID_CODES)

    assert [(item.code, item.quantity) for item in candidates] == [("M6", 7)]


def test_compact_pair_split_uses_palette_and_total_without_guessing_ambiguity() -> None:
    codes = frozenset({"C1", "C11", "F1", "F10", "F11"})

    assert compact_pair_candidates("C11350", codes, declared_total=1079) == (
        type(compact_pair_candidates("C11350", codes, 1079)[0])(code="C11", quantity=350),
    )
    assert [
        (item.code, item.quantity) for item in compact_pair_candidates("F11299", codes, 1131)
    ] == [("F11", 299)]
    assert [
        (item.code, item.quantity) for item in compact_pair_candidates("F10308", codes, 1079)
    ] == [
        ("F1", 308),
        ("F10", 308),
    ]
    assert compact_pair_candidates("B11", frozenset({"B1", "B11"}), 246) == ()
    assert compact_pair_candidates("F226", frozenset({"F2", "F22"}), 1131) == ()
    assert compact_pair_candidates("A13(13)", frozenset({"A1", "A13"}), 1159) == ()
