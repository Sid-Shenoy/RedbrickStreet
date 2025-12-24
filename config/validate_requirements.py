#!/usr/bin/env python3
"""
validate_script.py

Validate config/characters.json against config/houses.json and the objective
requirements listed in config/requirements.txt.

Usage:
  python validate_script.py
  python validate_script.py --characters ./config/characters.json --houses ./config/houses.json

Exit codes:
  0 = no anomalies found
  1 = anomalies found
  2 = could not read/parse input files
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict, Counter, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

ACCENT_ENUM = {"Canadian", "SouthAsian", "Chinese", "African", "MiddleEastern"}

# Requirement 1.4.2: only ASCII ' and " if apostrophes/quotes used
DISALLOWED_QUOTE_CHARS = {
    "\u2018",  # ‘
    "\u2019",  # ’
    "\u201C",  # “
    "\u201D",  # ”
    "\u2032",  # ′
    "\u2033",  # ″
    "\u00B4",  # ´
}

NAME_RE = re.compile(r"^[A-Za-z]+$")  # Req 2.2.2: no special chars in names
RELIGION_RE = re.compile(r"^\S+$")  # Req 2.2.7: single word (no spaces)
EPS = 1e-9  # float comparisons for bounds

def is_int(x: Any) -> bool:
    # Important: bool is a subclass of int; reject bool
    return isinstance(x, int) and not isinstance(x, bool)

def is_number(x: Any) -> bool:
    # Accept int/float (reject bool)
    return (isinstance(x, (int, float)) and not isinstance(x, bool))

def approx_equal(a: float, b: float, eps: float = EPS) -> bool:
    return abs(a - b) <= eps


@dataclass
class Issue:
    level: str  # "ERROR" or "WARN"
    requirement: str
    message: str


def _line_col_from_index(text: str, idx: int) -> Tuple[int, int]:
    # 1-based line/col
    line = text.count("\n", 0, idx) + 1
    last_nl = text.rfind("\n", 0, idx)
    col = idx - (last_nl + 1) + 1
    return line, col


def scan_for_disallowed_quotes(path: Path, raw_text: str) -> List[Issue]:
    issues: List[Issue] = []
    for i, ch in enumerate(raw_text):
        if ch in DISALLOWED_QUOTE_CHARS:
            line, col = _line_col_from_index(raw_text, i)
            issues.append(
                Issue(
                    "ERROR",
                    "1.4.2",
                    f"{path}: disallowed quote/apostrophe character {repr(ch)} at line {line}, col {col}. "
                    "Use ASCII ' and \" only.",
                )
            )
    return issues


def load_utf8_text(path: Path) -> Tuple[Optional[str], List[Issue]]:
    issues: List[Issue] = []
    try:
        raw = path.read_text(encoding="utf-8", errors="strict")
        return raw, issues
    except UnicodeDecodeError as e:
        issues.append(
            Issue(
                "ERROR",
                "1.4.1",
                f"{path}: file is not valid UTF-8 (UnicodeDecodeError: {e}).",
            )
        )
        return None, issues
    except FileNotFoundError:
        issues.append(Issue("ERROR", "1.1/2.x", f"{path}: file not found."))
        return None, issues


def load_json(path: Path, raw_text: str) -> Tuple[Optional[Any], List[Issue]]:
    issues: List[Issue] = []
    try:
        return json.loads(raw_text), issues
    except json.JSONDecodeError as e:
        issues.append(
            Issue(
                "ERROR",
                "1.2",
                f"{path}: invalid JSON (line {e.lineno}, col {e.colno}): {e.msg}",
            )
        )
        return None, issues


def is_int(x: Any) -> bool:
    # Important: bool is a subclass of int; reject bool
    return isinstance(x, int) and not isinstance(x, bool)


def normalize_case(s: str) -> str:
    return s.strip().casefold()


def _validate_bounds_for_house(hn: int, h: Dict[str, Any]) -> List[Issue]:
    """
    Req 2.3.5.* + 2.3.6.* (per-house parts)
    """
    issues: List[Issue] = []
    b = h.get("bounds")
    if not isinstance(b, dict):
        issues.append(Issue("ERROR", "2.3.5.1", f"houses.json: house {hn} missing/invalid bounds object."))
        return issues

    # Required numeric keys
    missing_keys = [k for k in ("x", "z", "xsize", "zsize") if k not in b]
    if missing_keys:
        issues.append(Issue("ERROR", "2.3.5.2", f"houses.json: house {hn} bounds missing key(s): {missing_keys}."))
        return issues

    x = b.get("x")
    z = b.get("z")
    xsize = b.get("xsize")
    zsize = b.get("zsize")

    if not is_number(x) or not is_number(z) or not is_number(xsize) or not is_int(zsize):
        issues.append(
            Issue(
                "ERROR",
                "2.3.5.2",
                f"houses.json: house {hn} bounds must have numeric x/z/xsize and integer zsize; got "
                f"x={x!r}, z={z!r}, xsize={xsize!r}, zsize={zsize!r}.",
            )
        )
        return issues

    x_f = float(x)
    z_f = float(z)
    xsize_f = float(xsize)
    zsize_i = int(zsize)

    # Domain constraints
    if x_f < -EPS or x_f > 70 + EPS:
        issues.append(Issue("ERROR", "2.3.5.2.1", f"houses.json: house {hn} bounds.x={x} out of range [0,70]."))
    if z_f < -EPS or z_f > 200 + EPS:
        issues.append(Issue("ERROR", "2.3.5.2.2", f"houses.json: house {hn} bounds.z={z} out of range [0,200]."))

    # Size constraints
    if not approx_equal(xsize_f, 30.0):
        issues.append(Issue("ERROR", "2.3.5.2.3", f"houses.json: house {hn} bounds.xsize must be 30, got {xsize!r}."))
    if not (10 <= zsize_i <= 16):
        issues.append(
            Issue(
                "ERROR",
                "2.3.5.2.3",
                f"houses.json: house {hn} bounds.zsize must be integer in [10,16], got {zsize!r}.",
            )
        )

    # Extents
    if x_f + xsize_f > 70 + EPS:
        issues.append(
            Issue(
                "ERROR",
                "2.3.5.2.4",
                f"houses.json: house {hn} bounds.x + xsize = {x_f + xsize_f} exceeds 70.",
            )
        )
    if z_f + zsize_i > 200 + EPS:
        issues.append(
            Issue(
                "ERROR",
                "2.3.5.2.5",
                f"houses.json: house {hn} bounds.z + zsize = {z_f + zsize_i} exceeds 200.",
            )
        )

    # Side constraints (even vs odd)
    if hn % 2 == 0:
        # Req 2.3.6.3.1: even houses x=0, xsize=30
        if not approx_equal(x_f, 0.0):
            issues.append(Issue("ERROR", "2.3.6.3.1", f"houses.json: even house {hn} must have bounds.x=0, got {x!r}."))
        if not approx_equal(xsize_f, 30.0):
            issues.append(
                Issue("ERROR", "2.3.6.3.1", f"houses.json: even house {hn} must have bounds.xsize=30, got {xsize!r}.")
            )
    else:
        # Req 2.3.6.3.2: odd houses x=40, xsize=30
        if not approx_equal(x_f, 40.0):
            issues.append(Issue("ERROR", "2.3.6.3.2", f"houses.json: odd house {hn} must have bounds.x=40, got {x!r}."))
        if not approx_equal(xsize_f, 30.0):
            issues.append(
                Issue("ERROR", "2.3.6.3.2", f"houses.json: odd house {hn} must have bounds.xsize=30, got {xsize!r}.")
            )

    return issues


def validate_street_geometry(houses_by_number: Dict[int, Dict[str, Any]]) -> List[Issue]:
    """
    Global constraints along z-axis per side
    Also emits a WARN for 3.4 if a side has no variance in zsize.
    """
    issues: List[Issue] = []

    even_expected = list(range(0, 30, 2))  # 0..28
    odd_expected = list(range(1, 30, 2))   # 1..29

    # Presence/order constraints
    even_present = [hn for hn in even_expected if hn in houses_by_number]
    odd_present = [hn for hn in odd_expected if hn in houses_by_number]

    if even_present != even_expected:
        missing = [hn for hn in even_expected if hn not in houses_by_number]
        if missing:
            issues.append(Issue("ERROR", "2.3.6.4.1", f"Even side missing houseNumber(s): {missing}."))

    if odd_present != odd_expected:
        missing = [hn for hn in odd_expected if hn not in houses_by_number]
        if missing:
            issues.append(Issue("ERROR", "2.3.6.4.2", f"Odd side missing houseNumber(s): {missing}."))

    def side_check(side_hns: List[int], side_label: str) -> List[int]:
        expected_z = 0.0
        zsizes: List[int] = []
        for hn in side_hns:
            h = houses_by_number.get(hn, {})
            b = h.get("bounds")
            if not isinstance(b, dict):
                continue
            z = b.get("z")
            zsize = b.get("zsize")
            if not is_number(z) or not is_int(zsize):
                continue

            z_f = float(z)
            zsize_i = int(zsize)

            # Contiguity: each house starts where previous ended
            if not approx_equal(z_f, expected_z):
                issues.append(
                    Issue(
                        "ERROR",
                        "2.3.6.4.3",
                        f"{side_label}: house {hn} bounds.z={z_f} but expected {expected_z} (gap/overlap).",
                    )
                )
                expected_z = z_f  # reduce cascading noise

            zsizes.append(zsize_i)
            expected_z = expected_z + zsize_i

        # Sum constraint
        if not approx_equal(expected_z, 200.0):
            issues.append(Issue("ERROR", "2.3.6.5", f"{side_label}: z-lengths sum/end at {expected_z}, expected 200."))

        return zsizes

    # Only run detailed contiguity checks if all houses exist (keeps output cleaner)
    if all(hn in houses_by_number for hn in even_expected):
        even_zsizes = side_check(even_expected, "Even side (2.3.6.4.1)")
        if even_zsizes and len(set(even_zsizes)) == 1:
            issues.append(
                Issue(
                    "WARN",
                    "3.4",
                    f"Even side: all house zsize values are identical ({even_zsizes[0]}). Requirement 3.4 suggests some variance.",
                )
            )

    if all(hn in houses_by_number for hn in odd_expected):
        odd_zsizes = side_check(odd_expected, "Odd side (2.3.6.4.2)")
        if odd_zsizes and len(set(odd_zsizes)) == 1:
            issues.append(
                Issue(
                    "WARN",
                    "3.4",
                    f"Odd side: all house zsize values are identical ({odd_zsizes[0]}). Requirement 3.4 suggests some variance.",
                )
            )

    return issues


def validate_houses(houses: Any) -> Tuple[Dict[int, Dict[str, Any]], List[Issue]]:
    issues: List[Issue] = []
    by_number: Dict[int, Dict[str, Any]] = {}

    if not isinstance(houses, list):
        issues.append(Issue("ERROR", "2.3", "houses.json: expected a top-level JSON array."))
        return by_number, issues

    # Must be 30 houses
    if len(houses) != 30:
        issues.append(Issue("ERROR", "2.3", f"houses.json: expected 30 houses, found {len(houses)}."))

    seen_numbers: Set[int] = set()
    for idx, h in enumerate(houses):
        if not isinstance(h, dict):
            issues.append(Issue("ERROR", "2.3", f"houses.json: entry index {idx} is not an object."))
            continue

        hn = h.get("houseNumber")
        if not is_int(hn):
            issues.append(Issue("ERROR", "2.3.1", f"houses.json: entry index {idx} missing/invalid houseNumber."))
            continue
        if hn < 0 or hn > 29:
            issues.append(Issue("ERROR", "2.3.1", f"houses.json: houseNumber {hn} out of range 0..29."))
        if hn in seen_numbers:
            issues.append(Issue("ERROR", "2.3.1", f"houses.json: duplicate houseNumber {hn}."))
            continue
        seen_numbers.add(hn)

        occupants = h.get("occupants")
        if not isinstance(occupants, list) or not occupants:
            issues.append(Issue("ERROR", "2.3.3/2.3.4", f"houses.json: house {hn} missing/invalid occupants list."))
            continue
        if not (1 <= len(occupants) <= 6):
            issues.append(
                Issue(
                    "ERROR",
                    "2.3.4",
                    f"houses.json: house {hn} occupants count {len(occupants)} not in [1, 6].",
                )
            )
        for occ in occupants:
            if not is_int(occ):
                issues.append(
                    Issue(
                        "ERROR",
                        "2.3.3",
                        f"houses.json: house {hn} has non-integer occupant id: {repr(occ)}.",
                    )
                )

        # House 7 special
        if hn == 7:
            if "surname" in h:
                issues.append(Issue("ERROR", "2.3.2.1", "houses.json: house 7 must not define 'surname'."))
            if occupants != [0]:
                issues.append(Issue("ERROR", "2.4", f"houses.json: house 7 occupants must be [0], got {occupants}."))
        else:
            surname = h.get("surname")
            if not isinstance(surname, str) or not surname.strip():
                issues.append(Issue("ERROR", "2.3.2", f"houses.json: house {hn} missing/invalid surname."))
            else:
                # House surname should be clean-ish; not strictly specified, but report if weird
                if not NAME_RE.match(surname.strip()):
                    issues.append(
                        Issue(
                            "WARN",
                            "2.3.2",
                            f"houses.json: house {hn} surname {surname!r} contains non A-Za-z characters.",
                        )
                    )

        # New: bounds validation (all houses, including house 7)
        issues.extend(_validate_bounds_for_house(hn, h))

        by_number[hn] = h

    # Ensure all 0..29 present
    missing = [n for n in range(30) if n not in seen_numbers]
    if missing:
        issues.append(Issue("ERROR", "2.3.1", f"houses.json: missing houseNumber(s): {missing}."))

    # house surnames should be unique across houses except house 7
    surnames: List[str] = []
    for hn, h in by_number.items():
        if hn == 7:
            continue
        s = h.get("surname")
        if isinstance(s, str) and s.strip():
            surnames.append(s.strip())
    dup = {s: c for s, c in Counter(surnames).items() if c > 1}
    if dup:
        issues.append(Issue("ERROR", "2.5", f"houses.json: duplicate house surnames detected: {dup}."))

    issues.extend(validate_street_geometry(by_number))

    return by_number, issues


def validate_characters(characters: Any) -> Tuple[Dict[int, Dict[str, Any]], List[Issue]]:
    issues: List[Issue] = []
    by_id: Dict[int, Dict[str, Any]] = {}

    if not isinstance(characters, list):
        issues.append(Issue("ERROR", "2.2", "characters.json: expected a top-level JSON array."))
        return by_id, issues

    # 70 to 80 NPCs plus player (player not included in NPC list)
    npc_count = len(characters)
    if not (70 <= npc_count <= 80):
        issues.append(
            Issue("ERROR", "2.1/2.4.1", f"characters.json: expected 70..80 NPC entries, found {npc_count}.")
        )

    # Validate each NPC
    first_names_ci: Dict[str, int] = {}
    handles_ci: Dict[str, int] = {}

    for idx, c in enumerate(characters):
        if not isinstance(c, dict):
            issues.append(Issue("ERROR", "2.2", f"characters.json: entry index {idx} is not an object."))
            continue

        cid = c.get("id")
        if not is_int(cid):
            issues.append(Issue("ERROR", "2.2.1", f"characters.json: entry index {idx} missing/invalid integer id."))
            continue
        if cid == 0:
            issues.append(Issue("ERROR", "2.4.1", "characters.json: player id=0 must NOT appear in characters.json."))
        if cid in by_id:
            issues.append(Issue("ERROR", "2.2.1", f"characters.json: duplicate NPC id={cid}."))
            continue
        by_id[cid] = c

        fn = c.get("firstName")
        ln = c.get("lastName")
        if not isinstance(fn, str) or not fn.strip():
            issues.append(Issue("ERROR", "2.2.2", f"NPC id={cid}: missing/invalid firstName."))
        else:
            if not NAME_RE.match(fn.strip()):
                issues.append(Issue("ERROR", "2.2.2", f"NPC id={cid}: firstName {fn!r} has non A-Za-z characters."))
            key = normalize_case(fn)
            if key in first_names_ci:
                issues.append(
                    Issue(
                        "ERROR",
                        "2.6",
                        f"NPC id={cid}: firstName {fn!r} duplicates NPC id={first_names_ci[key]} (case-insensitive).",
                    )
                )
            else:
                first_names_ci[key] = cid

        if not isinstance(ln, str) or not ln.strip():
            issues.append(Issue("ERROR", "2.2.2", f"NPC id={cid}: missing/invalid lastName."))
        else:
            if not NAME_RE.match(ln.strip()):
                issues.append(Issue("ERROR", "2.2.2", f"NPC id={cid}: lastName {ln!r} has non A-Za-z characters."))

        gender = c.get("gender")
        if gender not in {"M", "F"}:
            issues.append(Issue("ERROR", "2.2.3", f"NPC id={cid}: gender must be 'M' or 'F', got {gender!r}."))

        age = c.get("age")
        if not is_int(age):
            issues.append(Issue("ERROR", "2.2.4", f"NPC id={cid}: age must be an integer, got {age!r}."))
        else:
            if age <= 5:
                issues.append(Issue("ERROR", "2.2.4.2", f"NPC id={cid}: age={age} is not allowed (must be >= 6)."))

        accent = c.get("accentLanguage")
        if accent not in ACCENT_ENUM:
            issues.append(
                Issue(
                    "ERROR",
                    "2.2.5",
                    f"NPC id={cid}: accentLanguage must be one of {sorted(ACCENT_ENUM)}, got {accent!r}.",
                )
            )

        career = c.get("career")
        if not isinstance(career, str) or not career.strip():
            issues.append(Issue("ERROR", "2.2.6", f"NPC id={cid}: missing/invalid career."))

        religion = c.get("religion")
        if not isinstance(religion, str) or not religion.strip() or not RELIGION_RE.match(religion.strip()):
            issues.append(Issue("ERROR", "2.2.7", f"NPC id={cid}: religion must be a single word, got {religion!r}."))

        # Personality traits
        traits = c.get("personalityTraits")
        if not isinstance(traits, list) or len(traits) != 3 or not all(isinstance(t, str) and t.strip() for t in traits):
            issues.append(Issue("ERROR", "2.2.9", f"NPC id={cid}: personalityTraits must be a list of 3 strings."))
        else:
            if len(set(map(normalize_case, traits))) != 3:
                issues.append(Issue("WARN", "2.2.9", f"NPC id={cid}: personalityTraits contains duplicates: {traits}"))

        # Interests
        interests = c.get("interests")
        if (
            not isinstance(interests, list)
            or len(interests) != 3
            or not all(isinstance(i, str) and i.strip() for i in interests)
        ):
            issues.append(Issue("ERROR", "2.2.10", f"NPC id={cid}: interests must be a list of 3 strings."))
        else:
            if len(set(map(normalize_case, interests))) != 3:
                issues.append(Issue("WARN", "2.2.10", f"NPC id={cid}: interests contains duplicates: {interests}"))

        # About facts
        about = c.get("about")
        if not isinstance(about, list) or len(about) != 5 or not all(isinstance(a, str) and a.strip() for a in about):
            issues.append(Issue("ERROR", "2.2.11", f"NPC id={cid}: about must be a list of exactly 5 non-empty strings."))

        # Social media
        sm = c.get("socialMedia")
        if not isinstance(sm, dict):
            issues.append(Issue("ERROR", "2.2.12", f"NPC id={cid}: missing/invalid socialMedia object."))
        else:
            handle = sm.get("handle")
            bio = sm.get("bio")
            followers = sm.get("followers")
            following = sm.get("following")

            if not isinstance(handle, str) or not handle.strip():
                issues.append(Issue("ERROR", "2.2.12.1", f"NPC id={cid}: socialMedia.handle missing/invalid."))
            else:
                if "@" in handle:
                    issues.append(
                        Issue("ERROR", "2.2.12.1", f"NPC id={cid}: socialMedia.handle must not include '@': {handle!r}.")
                    )
                hkey = normalize_case(handle)
                if hkey in handles_ci:
                    issues.append(
                        Issue(
                            "ERROR",
                            "2.7",
                            f"NPC id={cid}: socialMedia.handle {handle!r} duplicates NPC id={handles_ci[hkey]} "
                            "(case-insensitive).",
                        )
                    )
                else:
                    handles_ci[hkey] = cid

            if not isinstance(bio, str) or not bio.strip():
                issues.append(Issue("ERROR", "2.2.12.2", f"NPC id={cid}: socialMedia.bio missing/invalid."))

            if not is_int(followers) or followers < 0:
                issues.append(Issue("ERROR", "2.2.12.3", f"NPC id={cid}: socialMedia.followers must be int >=0."))
            if not is_int(following) or following < 0:
                issues.append(Issue("ERROR", "2.2.12.4", f"NPC id={cid}: socialMedia.following must be int >=0."))

        # Family info (required)
        fam = c.get("family")
        if not isinstance(fam, dict):
            issues.append(Issue("ERROR", "2.2.8", f"NPC id={cid}: missing/invalid family object."))
        else:
            # Only marriage, parent/child, siblings (we model spouse + children)
            extra_keys = set(fam.keys()) - {"spouse", "children"}
            if extra_keys:
                issues.append(
                    Issue(
                        "ERROR",
                        "2.2.8.1",
                        f"NPC id={cid}: family has unsupported keys {sorted(extra_keys)} (allowed: spouse, children).",
                    )
                )

            spouse = fam.get("spouse")
            children = fam.get("children")

            if not is_int(spouse):
                issues.append(Issue("ERROR", "2.2.8", f"NPC id={cid}: family.spouse must be an int (or -1)."))
            if spouse == cid:
                issues.append(Issue("ERROR", "2.2.8", f"NPC id={cid}: family.spouse cannot be self."))
            if spouse is not None and is_int(spouse) and spouse != -1 and spouse == 0:
                issues.append(Issue("ERROR", "2.4.1", f"NPC id={cid}: family.spouse references player id=0."))

            if not isinstance(children, list) or not all(is_int(ch) for ch in children):
                issues.append(Issue("ERROR", "2.2.8", f"NPC id={cid}: family.children must be a list of integer ids."))
            else:
                if 0 in children:
                    issues.append(Issue("ERROR", "2.4.1", f"NPC id={cid}: family.children references player id=0."))
                if cid in children:
                    issues.append(Issue("ERROR", "2.2.8", f"NPC id={cid}: family.children cannot contain self."))

    return by_id, issues


def build_relationship_indexes(
    chars_by_id: Dict[int, Dict[str, Any]],
) -> Tuple[Dict[int, int], Dict[int, Set[int]], Dict[int, Set[int]], List[Issue]]:
    """
    Returns:
      spouse_of: mapping id -> spouse_id (only for spouse != -1)
      parents_of_child: mapping child_id -> set(parent_ids)
      children_of_parent: mapping parent_id -> set(child_ids)
      issues: relationship consistency issues
    """
    issues: List[Issue] = []
    spouse_of: Dict[int, int] = {}
    children_of_parent: Dict[int, Set[int]] = defaultdict(set)
    parents_of_child: Dict[int, Set[int]] = defaultdict(set)

    # Collect spouse and children links
    for cid, c in chars_by_id.items():
        fam = c.get("family", {})
        spouse = fam.get("spouse")
        if is_int(spouse) and spouse != -1:
            spouse_of[cid] = spouse

        children = fam.get("children")
        if isinstance(children, list):
            for ch in children:
                if not is_int(ch):
                    continue
                children_of_parent[cid].add(ch)
                parents_of_child[ch].add(cid)

    # Validate spouse constraints: no multiple spouses, symmetric, M/F, age>=18
    reverse_spouse: Dict[int, List[int]] = defaultdict(list)
    for a, b in spouse_of.items():
        reverse_spouse[b].append(a)

    for b, partners in reverse_spouse.items():
        # This catches multiple spouses pointing at same person
        if len(partners) > 1:
            issues.append(
                Issue("ERROR", "2.2.8.3", f"NPC id={b}: multiple spouses reference this NPC: {sorted(partners)}.")
            )

    for a, b in spouse_of.items():
        if b not in chars_by_id:
            issues.append(Issue("ERROR", "2.2.8", f"NPC id={a}: spouse id={b} does not exist in characters.json."))
            continue

        # Symmetry
        b_spouse = chars_by_id[b].get("family", {}).get("spouse")
        if not (is_int(b_spouse) and b_spouse == a):
            issues.append(
                Issue(
                    "ERROR",
                    "2.2.8",
                    f"NPC id={a}: spouse id={b} is not symmetric (NPC id={b} has family.spouse={b_spouse!r}).",
                )
            )

        # Marriage must be between one man and one woman
        a_gender = chars_by_id[a].get("gender")
        b_gender = chars_by_id[b].get("gender")
        if a_gender in {"M", "F"} and b_gender in {"M", "F"} and a_gender == b_gender:
            issues.append(
                Issue(
                    "ERROR",
                    "2.2.8.2",
                    f"Marriage gender violation: NPC id={a} gender={a_gender} married to NPC id={b} gender={b_gender}.",
                )
            )

        # Both >= 18
        a_age = chars_by_id[a].get("age")
        b_age = chars_by_id[b].get("age")
        if is_int(a_age) and a_age < 18:
            issues.append(Issue("ERROR", "2.2.8.4", f"NPC id={a}: married but age={a_age} (<18)."))
        if is_int(b_age) and b_age < 18:
            issues.append(Issue("ERROR", "2.2.8.4", f"NPC id={b}: married but age={b_age} (<18)."))

    # Validate children constraints: parents >=18, parent >= child+18, child exists, child <=17 cannot have children/spouse, etc.
    for p, kids in children_of_parent.items():
        p_age = chars_by_id.get(p, {}).get("age")
        if is_int(p_age) and p_age < 18:
            issues.append(Issue("ERROR", "2.2.8.5", f"NPC id={p}: has children but age={p_age} (<18)."))

        for ch in kids:
            if ch not in chars_by_id:
                issues.append(Issue("ERROR", "2.2.8", f"NPC id={p}: references non-existent child id={ch}."))
                continue
            ch_age = chars_by_id[ch].get("age")
            if is_int(p_age) and is_int(ch_age):
                if p_age - ch_age < 18:
                    issues.append(
                        Issue(
                            "ERROR",
                            "2.2.8.6",
                            f"Parent/child age gap violation: parent id={p} age={p_age}, child id={ch} age={ch_age} "
                            "(must be >= 18 years older).",
                        )
                    )

    # Validate child has at most 2 parents; if 2, they must be M/F and spouses (strongly implied by 2.2.8.1 limits)
    for ch, ps in parents_of_child.items():
        if len(ps) > 2:
            issues.append(
                Issue("ERROR", "2.2.8.1", f"Child id={ch}: has {len(ps)} parents listed: {sorted(ps)} (max 2).")
            )
        if len(ps) == 2:
            p1, p2 = sorted(ps)
            g1 = chars_by_id[p1].get("gender")
            g2 = chars_by_id[p2].get("gender")
            if g1 == g2 and g1 in {"M", "F"}:
                issues.append(
                    Issue(
                        "ERROR",
                        "2.2.8.2",
                        f"Child id={ch}: two parents share same gender: parent {p1} gender={g1}, parent {p2} gender={g2}.",
                    )
                )
            # Spouse symmetry check
            p1_sp = chars_by_id[p1].get("family", {}).get("spouse")
            p2_sp = chars_by_id[p2].get("family", {}).get("spouse")
            if not (is_int(p1_sp) and p1_sp == p2 and is_int(p2_sp) and p2_sp == p1):
                issues.append(
                    Issue(
                        "WARN",
                        "2.2.8.1",
                        f"Child id={ch}: two parents {p1} and {p2} are not mutually spouses "
                        f"(p1.spouse={p1_sp!r}, p2.spouse={p2_sp!r}).",
                    )
                )

    return spouse_of, parents_of_child, children_of_parent, issues


def build_house_index(houses_by_number: Dict[int, Dict[str, Any]]) -> Dict[int, int]:
    """occupant_id -> houseNumber (first occurrence)."""
    occ_to_house: Dict[int, int] = {}
    for hn, h in houses_by_number.items():
        occupants = h.get("occupants", [])
        if isinstance(occupants, list):
            for occ in occupants:
                if is_int(occ) and occ not in occ_to_house:
                    occ_to_house[occ] = hn
    return occ_to_house


def validate_cross_file_consistency(
    chars_by_id: Dict[int, Dict[str, Any]],
    houses_by_number: Dict[int, Dict[str, Any]],
    spouse_of: Dict[int, int],
    parents_of_child: Dict[int, Set[int]],
    children_of_parent: Dict[int, Set[int]],
) -> List[Issue]:
    issues: List[Issue] = []

    # Req 2.8 + 2.4: each NPC must live in exactly one house; player only in house 7.
    seen_occurrences: Dict[int, List[int]] = defaultdict(list)
    for hn, h in houses_by_number.items():
        occs = h.get("occupants")
        if not isinstance(occs, list):
            continue
        for occ in occs:
            if not is_int(occ):
                continue
            seen_occurrences[occ].append(hn)

    # Player rules
    if 0 in chars_by_id:
        issues.append(Issue("ERROR", "2.4.1", "Player id=0 must not be present in characters.json."))

    # Occupant ids must exist (except player 0)
    for occ, hns in seen_occurrences.items():
        if occ == 0:
            continue
        if occ not in chars_by_id:
            issues.append(
                Issue(
                    "ERROR",
                    "2.3.3/2.8",
                    f"houses.json: occupant id={occ} appears in house(s) {sorted(hns)} but is missing in characters.json.",
                )
            )
        if len(set(hns)) != 1:
            issues.append(
                Issue(
                    "ERROR",
                    "2.8",
                    f"NPC id={occ} appears in multiple houses: {sorted(set(hns))} (must be exactly one).",
                )
            )

    # Every NPC must appear in exactly one house
    for cid in chars_by_id.keys():
        if cid == 0:
            continue
        if cid not in seen_occurrences:
            issues.append(Issue("ERROR", "2.8", f"NPC id={cid} does not appear in any house occupants list."))
        else:
            hns = set(seen_occurrences[cid])
            if len(hns) != 1:
                issues.append(
                    Issue("ERROR", "2.8", f"NPC id={cid} appears in multiple houses {sorted(hns)} (must be 1).")
                )

    # Req 2.3.2 + 2.9: all occupants in a house share the house surname, and are related.
    # Build relationships edges (spouse, parent-child, siblings derived from shared parents)
    def related_edges(occupants: List[int]) -> Dict[int, Set[int]]:
        g: Dict[int, Set[int]] = {o: set() for o in occupants}
        occ_set = set(occupants)

        # spouse edges
        for a in occupants:
            b = spouse_of.get(a)
            if b is not None and b in occ_set:
                g[a].add(b)
                g[b].add(a)

        # parent-child edges (undirected for connectivity)
        for p in occupants:
            for ch in children_of_parent.get(p, set()):
                if ch in occ_set:
                    g[p].add(ch)
                    g[ch].add(p)

        # sibling edges (shared parent)
        # derive siblings among occupants
        parents_map: Dict[int, Set[int]] = {o: parents_of_child.get(o, set()) for o in occupants}
        for i in range(len(occupants)):
            a = occupants[i]
            for j in range(i + 1, len(occupants)):
                b = occupants[j]
                if parents_map[a] and parents_map[b] and parents_map[a].intersection(parents_map[b]):
                    g[a].add(b)
                    g[b].add(a)

        return g

    # Helper for connectivity
    def is_connected(graph: Dict[int, Set[int]], nodes: List[int]) -> bool:
        if not nodes:
            return True
        start = nodes[0]
        seen: Set[int] = set()
        dq = deque([start])
        while dq:
            u = dq.popleft()
            if u in seen:
                continue
            seen.add(u)
            for v in graph.get(u, set()):
                if v not in seen:
                    dq.append(v)
        return len(seen) == len(nodes)

    # occupant->house lookup
    occ_to_house = build_house_index(houses_by_number)

    # Req 2.5: no surname shared across different houses (based on where NPCs actually live)
    surname_to_houses: Dict[str, Set[int]] = defaultdict(set)
    for cid, c in chars_by_id.items():
        if cid == 0:
            continue
        hn = occ_to_house.get(cid)
        if hn is None:
            continue
        ln = c.get("lastName")
        if isinstance(ln, str) and ln.strip():
            surname_to_houses[ln.strip()].add(hn)

    for ln, hset in sorted(surname_to_houses.items(), key=lambda x: x[0]):
        if len(hset) > 1:
            issues.append(
                Issue(
                    "ERROR",
                    "2.5",
                    f"Surname {ln!r} appears across multiple houses {sorted(hset)} (must be unique per house).",
                )
            )

    for hn, h in houses_by_number.items():
        occs_any = h.get("occupants", [])
        if not isinstance(occs_any, list):
            continue
        occs = [o for o in occs_any if is_int(o)]

        if hn == 7:
            # already validated in validate_houses, but double-check
            if occs != [0]:
                issues.append(Issue("ERROR", "2.4", f"house 7 must be [0], got {occs_any!r}"))
            continue

        # Surname match: all occupants' lastName must match house surname
        house_surname = h.get("surname")
        if not isinstance(house_surname, str) or not house_surname.strip():
            # already flagged, but avoid crash
            continue
        house_surname = house_surname.strip()

        for occ in occs:
            if occ == 0:
                issues.append(Issue("ERROR", "2.4", f"house {hn}: player id=0 must not live in houses other than 7."))
                continue
            c = chars_by_id.get(occ)
            if not c:
                continue
            ln = c.get("lastName")
            if isinstance(ln, str) and ln.strip():
                if ln.strip() != house_surname:
                    issues.append(
                        Issue(
                            "ERROR",
                            "2.3.2/2.9",
                            f"house {hn}: occupant id={occ} lastName={ln.strip()!r} != house surname {house_surname!r}.",
                        )
                    )

        # Relatedness: all NPCs in same house must be related (connectivity under spouse/parent-child/sibling)
        occs_no_player = [o for o in occs if o != 0 and o in chars_by_id]
        if len(occs_no_player) >= 2:
            graph = related_edges(occs_no_player)
            if not is_connected(graph, occs_no_player):
                # Provide components for easier debugging
                components: List[List[int]] = []
                unseen = set(occs_no_player)
                while unseen:
                    start = next(iter(unseen))
                    comp: Set[int] = set()
                    dq = deque([start])
                    while dq:
                        u = dq.popleft()
                        if u in comp:
                            continue
                        comp.add(u)
                        for v in graph.get(u, set()):
                            if v not in comp:
                                dq.append(v)
                    unseen -= comp
                    components.append(sorted(comp))
                issues.append(
                    Issue(
                        "ERROR",
                        "2.9",
                        f"house {hn}: occupants are not all related under allowed relationships. "
                        f"Disconnected components: {components}",
                    )
                )

    # Req 2.2.4.1: minors (<=17) must live with an adult family member (>=18) in their house.
    # We'll interpret "family member" using the same relationship graph (spouse/parent/child/sibling).
    for cid, c in chars_by_id.items():
        if cid == 0:
            continue
        age = c.get("age")
        if not is_int(age):
            continue
        if age <= 17:
            hn = occ_to_house.get(cid)
            if hn is None:
                continue
            occs = houses_by_number.get(hn, {}).get("occupants", [])
            if not isinstance(occs, list):
                continue
            occs_house = [o for o in occs if is_int(o) and o in chars_by_id]
            # Build relation graph within house occupants
            graph = None
            if len(occs_house) >= 2:
                graph = related_edges(occs_house)
            # Find reachable adults from minor
            has_adult_family = False
            if graph and cid in graph:
                seen: Set[int] = set()
                dq = deque([cid])
                while dq:
                    u = dq.popleft()
                    if u in seen:
                        continue
                    seen.add(u)
                    u_age = chars_by_id[u].get("age")
                    if is_int(u_age) and u_age >= 18 and u != cid:
                        has_adult_family = True
                        break
                    for v in graph.get(u, set()):
                        if v not in seen:
                            dq.append(v)
            else:
                # If the only occupant or graph missing, cannot satisfy unless there's an adult occupant (which would imply >=2 anyway)
                has_adult_family = False

            if not has_adult_family:
                # If there is an adult in the house but not related, this will still fail (as it should)
                adults_in_house = [
                    o for o in occs_house if is_int(chars_by_id[o].get("age")) and chars_by_id[o].get("age") >= 18
                ]
                issues.append(
                    Issue(
                        "ERROR",
                        "2.2.4.1",
                        f"Minor NPC id={cid} age={age} in house {hn} does not live with a related adult family member. "
                        f"Adult occupants present: {sorted(adults_in_house)}",
                    )
                )

    # Additional objective checks derived from requirements:
    # - Minors cannot be married or have children (implied by 2.2.8.4 and 2.2.8.5)
    for cid, c in chars_by_id.items():
        age = c.get("age")
        if not is_int(age):
            continue
        fam = c.get("family", {})
        spouse = fam.get("spouse")
        children = fam.get("children")
        if age < 18:
            if is_int(spouse) and spouse != -1:
                issues.append(Issue("ERROR", "2.2.8.4", f"NPC id={cid} age={age} is married (spouse={spouse})."))
            if isinstance(children, list) and len(children) > 0:
                issues.append(Issue("ERROR", "2.2.8.5", f"NPC id={cid} age={age} has children listed: {children}."))

    return issues


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--characters", default="config/characters.json", help="Path to characters.json")
    ap.add_argument("--houses", default="config/houses.json", help="Path to houses.json")
    args = ap.parse_args()

    char_path = Path(args.characters)
    house_path = Path(args.houses)

    all_issues: List[Issue] = []

    # Read & scan raw files
    char_raw, issues = load_utf8_text(char_path)
    all_issues.extend(issues)
    if char_raw is None:
        for iss in all_issues:
            print(f"{iss.level} [Req {iss.requirement}] {iss.message}")
        return 2
    all_issues.extend(scan_for_disallowed_quotes(char_path, char_raw))

    house_raw, issues = load_utf8_text(house_path)
    all_issues.extend(issues)
    if house_raw is None:
        for iss in all_issues:
            print(f"{iss.level} [Req {iss.requirement}] {iss.message}")
        return 2
    all_issues.extend(scan_for_disallowed_quotes(house_path, house_raw))

    # Parse JSON
    characters, issues = load_json(char_path, char_raw)
    all_issues.extend(issues)
    houses, issues = load_json(house_path, house_raw)
    all_issues.extend(issues)
    if characters is None or houses is None:
        for iss in all_issues:
            print(f"{iss.level} [Req {iss.requirement}] {iss.message}")
        return 2

    # Validate houses & characters independently
    houses_by_number, issues = validate_houses(houses)
    all_issues.extend(issues)

    chars_by_id, issues = validate_characters(characters)
    all_issues.extend(issues)

    # Relationship validations
    spouse_of, parents_of_child, children_of_parent, rel_issues = build_relationship_indexes(chars_by_id)
    all_issues.extend(rel_issues)

    # Cross-file validations (houses <-> characters, surname/relatedness, residency)
    cross_issues = validate_cross_file_consistency(
        chars_by_id=chars_by_id,
        houses_by_number=houses_by_number,
        spouse_of=spouse_of,
        parents_of_child=parents_of_child,
        children_of_parent=children_of_parent,
    )
    all_issues.extend(cross_issues)

    # Print issues (sorted for stable output)
    def sort_key(i: Issue) -> Tuple[int, str, str]:
        level_rank = 0 if i.level == "ERROR" else 1
        return (level_rank, i.requirement, i.message)

    all_issues_sorted = sorted(all_issues, key=sort_key)

    for iss in all_issues_sorted:
        print(f"{iss.level} [Req {iss.requirement}] {iss.message}")

    # Summary
    err_count = sum(1 for i in all_issues if i.level == "ERROR")
    warn_count = sum(1 for i in all_issues if i.level == "WARN")
    print()
    print("Summary:")
    print(f"- Errors: {err_count}")
    print(f"- Warnings: {warn_count}")

    # Note about subjective requirements we intentionally don't validate automatically
    print()
    print("Not automatically validated (subjective / non-objective requirements):")
    print("- 3.1 recurring themes across many NPCs")
    print("- 3.2 cultural voice corresponds to accent language")
    print("- 3.3 / 3.3.1 no aggression / no passive aggressiveness")

    return 0 if err_count == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
