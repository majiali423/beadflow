from app.pattern_legend import (
    OcrToken,
    infer_column_layout,
    materials_from_tokens,
    merge_material_results,
)


VALID_CODES = frozenset({"A3", "F11", "G8", "H16"})


def token(text: str, x: float, y: float, width: float = 30, height: float = 16) -> OcrToken:
    return OcrToken(text=text, x=x, y=y, width=width, height=height, confidence=0.95)


def test_pairs_codes_and_quantities_on_the_same_legend_row() -> None:
    tokens = [
        token("F11", 10, 20),
        token("(58)", 48, 20),
        token("G08", 120, 20),
        token("28", 160, 21),
        token("1", 10, 0),
        token("2", 50, 0),
    ]

    materials, conflicts = materials_from_tokens(tokens, VALID_CODES)

    assert materials == {"F11": 58, "G8": 28}
    assert conflicts == frozenset()


def test_small_ocr_box_overlap_does_not_pair_with_the_next_legend_card() -> None:
    tokens = [
        token("M6", 100, 20, width=33),
        token("14", 127, 20, width=30),
        token("F6", 175, 20, width=25),
        token("3", 211, 20, width=12),
    ]

    materials, conflicts = materials_from_tokens(tokens, frozenset({"M6", "F6"}))

    assert materials == {"M6": 14, "F6": 3}
    assert conflicts == frozenset()


def test_pairs_separate_code_and_count_rows_by_column() -> None:
    tokens = [
        token("A03", 20, 20),
        token("F11", 120, 20),
        token("3", 28, 55, width=12),
        token("55", 126, 55, width=20),
    ]

    materials, conflicts = materials_from_tokens(tokens, VALID_CODES)

    assert materials == {"A3": 3, "F11": 55}
    assert conflicts == frozenset()


def test_invalid_codes_and_unpaired_coordinates_do_not_become_materials() -> None:
    tokens = [
        token("Z99", 10, 20),
        token("22", 48, 20),
        token("H16", 200, 60),
        token("1", 10, 0),
        token("2", 50, 0),
    ]

    materials, conflicts = materials_from_tokens(tokens, VALID_CODES)

    assert materials == {}
    assert conflicts == frozenset()


def test_recovers_a_unique_merged_pair_but_leaves_ambiguous_prefixes_unresolved() -> None:
    tokens = [token("F11299", 10, 20), token("H16130", 120, 20)]

    materials, conflicts = materials_from_tokens(
        tokens, frozenset({"F1", "F11", "H16"}), declared_total=400
    )

    assert materials == {"F11": 299, "H16": 130}
    assert conflicts == frozenset()


def test_infers_repeated_columns_only_when_a_separate_quantity_run_exists() -> None:
    row = [token(f"G{index}", 20 + index * 80, 80) for index in range(1, 11)]
    quantity_run = token("47312435381542910111", 20, 140, width=800)

    layout = infer_column_layout(row + [quantity_run], image_width=900, image_height=200)

    assert layout is not None
    assert round(layout.pitch) == 80
    assert len(layout.centers) == 10
    assert infer_column_layout(row, image_width=900, image_height=200) is None


def test_merge_never_silently_chooses_between_conflicting_ocr_passes() -> None:
    materials, conflicts = merge_material_results(
        {"F11": 58, "H16": 56},
        frozenset(),
        {"F11": 59, "G8": 28},
        frozenset(),
    )

    assert materials == {"H16": 56, "G8": 28}
    assert conflicts == frozenset({"F11"})
