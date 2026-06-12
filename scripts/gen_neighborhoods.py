#!/usr/bin/env python3
"""Generates content/neighborhoods.json — the real-NYC skeleton (PRD §4.1).

Nodes are authored per borough; adjacency is an EDGE LIST so symmetry holds by
construction. Run: python3 scripts/gen_neighborhoods.py
"""
import json, os, sys
from collections import deque

# (id, area_type, x, y, subway, coastal, pop_k, prosperity, crime, faith)
MANHATTAN = [
    ("inwood", "grid_dense", 35, 3, ["A", "1"], 1, 45, .42, .42, .60),
    ("washington_heights", "grid_dense", 34, 6, ["A", "C", "1"], 1, 150, .40, .45, .65),
    ("hamilton_heights", "grid_dense", 33, 10, ["A", "C", "1"], 1, 50, .42, .48, .60),
    ("harlem", "grid_dense", 36, 12, ["2", "3", "A", "B", "C"], 0, 120, .45, .50, .70),
    ("east_harlem", "grid_dense", 38, 13, ["4", "5", "6"], 1, 115, .35, .55, .65),
    ("morningside_heights", "civic", 33, 14, ["1"], 1, 55, .68, .30, .55),
    ("upper_west_side", "grid_dense", 34, 19, ["1", "2", "3", "B", "C"], 1, 200, .82, .25, .50),
    ("upper_east_side", "grid_dense", 38, 20, ["4", "5", "6", "Q"], 1, 210, .90, .20, .45),
    ("hells_kitchen", "grid_dense", 33, 27, ["A", "C", "E"], 1, 60, .60, .40, .40),
    ("midtown", "grid_dense", 36, 27, ["1", "2", "7", "A", "E", "B", "D", "N", "Q"], 0, 90, .75, .45, .35),
    ("murray_hill", "grid_dense", 38, 30, ["4", "6", "7"], 1, 55, .70, .30, .35),
    ("chelsea", "grid_dense", 33, 32, ["1", "A", "C", "E"], 1, 65, .72, .30, .40),
    ("gramercy", "grid_dense", 37, 33, ["4", "6", "L", "N", "R"], 0, 60, .75, .28, .35),
    ("greenwich_village", "grid_dense", 34, 36, ["1", "A", "B", "C", "D", "E", "F", "M"], 0, 65, .80, .25, .30),
    ("east_village", "grid_dense", 37, 37, ["6", "F", "L"], 0, 70, .60, .40, .35),
    ("soho", "grid_dense", 34, 39, ["6", "C", "E", "R"], 0, 40, .85, .25, .25),
    ("lower_east_side", "grid_dense", 38, 40, ["F", "J", "M", "Z"], 1, 80, .50, .45, .55),
    ("chinatown", "grid_dense", 36, 42, ["6", "B", "D", "J", "N", "Q", "Z"], 0, 70, .45, .45, .60),
    ("tribeca", "grid_dense", 34, 43, ["1", "2", "3", "A", "C"], 1, 30, .90, .20, .25),
    ("financial_district", "grid_dense", 34, 47, ["1", "2", "3", "4", "5", "A", "C", "J", "R", "Z"], 1, 65, .80, .35, .30),
]
BRONX = [
    ("riverdale", "suburban", 38, 2, ["1"], 1, 50, .78, .15, .50),
    ("kingsbridge", "rowhouse", 41, 4, ["1"], 1, 40, .45, .40, .55),
    ("norwood", "rowhouse", 46, 3, ["D"], 0, 42, .40, .42, .55),
    ("wakefield", "suburban", 53, 1, ["2", "5"], 0, 35, .38, .50, .60),
    ("williamsbridge", "rowhouse", 52, 4, ["2", "5"], 0, 60, .35, .50, .60),
    ("co_op_city", "projects", 58, 5, [], 1, 45, .42, .35, .50),
    ("bedford_park", "rowhouse", 44, 5, ["4", "B", "D"], 0, 55, .38, .45, .55),
    ("fordham", "grid_dense", 45, 7, ["4", "B", "D"], 0, 85, .35, .50, .60),
    ("belmont", "rowhouse", 47, 8, [], 0, 30, .38, .42, .70),
    ("university_heights", "rowhouse", 42, 8, ["4"], 1, 55, .30, .55, .55),
    ("tremont", "rowhouse", 46, 10, ["B", "D"], 0, 70, .28, .58, .55),
    ("west_farms", "projects", 48, 10, ["2", "5"], 0, 40, .28, .58, .50),
    ("morris_park", "suburban", 52, 9, ["5"], 0, 35, .50, .35, .60),
    ("pelham_bay", "suburban", 57, 7, ["6"], 1, 50, .50, .30, .50),
    ("city_island", "waterfront", 62, 7, [], 1, 5, .55, .20, .55),
    ("throgs_neck", "suburban", 58, 11, [], 1, 45, .50, .30, .50),
    ("castle_hill", "projects", 54, 12, ["6"], 1, 40, .35, .50, .55),
    ("parkchester", "projects", 52, 11, ["6"], 0, 70, .40, .45, .50),
    ("soundview", "projects", 52, 14, ["6"], 1, 80, .30, .55, .50),
    ("highbridge", "rowhouse", 42, 11, ["4"], 1, 60, .28, .55, .55),
    ("concourse", "grid_dense", 43, 13, ["4", "B", "D"], 0, 90, .35, .50, .50),
    ("morrisania", "rowhouse", 45, 13, ["2", "5"], 0, 50, .25, .60, .60),
    ("melrose", "rowhouse", 44, 14, ["2", "5"], 0, 50, .30, .55, .55),
    ("mott_haven", "rowhouse", 44, 16, ["4", "5", "6"], 1, 60, .30, .60, .55),
    ("hunts_point", "industrial", 48, 15, ["6"], 1, 25, .25, .60, .50),
]
QUEENS = [
    ("astoria", "rowhouse", 48, 20, ["N", "W"], 1, 95, .55, .35, .50),
    ("long_island_city", "industrial", 47, 25, ["7", "E", "G", "M", "N", "W"], 1, 80, .65, .35, .35),
    ("sunnyside", "rowhouse", 52, 26, ["7"], 0, 50, .50, .30, .50),
    ("woodside", "rowhouse", 56, 26, ["7"], 0, 45, .48, .35, .55),
    ("jackson_heights", "grid_dense", 60, 24, ["7", "E", "F", "M", "R"], 0, 110, .45, .40, .60),
    ("east_elmhurst", "suburban", 62, 21, [], 1, 25, .42, .40, .55),
    ("corona", "rowhouse", 64, 26, ["7"], 0, 110, .35, .45, .60),
    ("elmhurst", "grid_dense", 60, 28, ["7", "M", "R"], 0, 100, .45, .40, .55),
    ("maspeth", "industrial", 56, 32, [], 0, 35, .45, .35, .50),
    ("middle_village", "suburban", 60, 33, ["M"], 0, 35, .50, .25, .55),
    ("ridgewood", "rowhouse", 56, 36, ["L", "M"], 0, 70, .45, .35, .55),
    ("glendale", "suburban", 60, 36, [], 0, 30, .48, .30, .50),
    ("rego_park", "grid_dense", 64, 30, ["M", "R"], 0, 45, .55, .30, .50),
    ("forest_hills", "grid_dense", 66, 32, ["E", "F", "M", "R"], 0, 85, .68, .22, .45),
    ("kew_gardens", "rowhouse", 68, 34, ["E", "F"], 0, 25, .55, .30, .50),
    ("flushing", "grid_dense", 78, 28, ["7"], 1, 180, .50, .35, .70),
    ("college_point", "industrial", 76, 22, [], 1, 25, .45, .30, .50),
    ("whitestone", "suburban", 80, 20, [], 1, 30, .60, .20, .50),
    ("bayside", "suburban", 86, 24, [], 1, 45, .65, .18, .45),
    ("fresh_meadows", "suburban", 80, 32, [], 0, 40, .55, .25, .50),
    ("jamaica", "grid_dense", 76, 40, ["E", "F", "J", "Z"], 0, 150, .35, .50, .65),
    ("richmond_hill", "rowhouse", 70, 40, ["J", "Z"], 0, 60, .40, .40, .60),
    ("woodhaven", "rowhouse", 66, 40, ["J", "Z"], 0, 40, .42, .38, .55),
    ("ozone_park", "rowhouse", 68, 46, ["A"], 0, 70, .40, .42, .55),
    ("howard_beach", "suburban", 70, 52, ["A"], 1, 30, .50, .30, .50),
    ("hollis", "suburban", 80, 38, [], 0, 25, .40, .42, .60),
    ("st_albans", "suburban", 82, 42, [], 0, 50, .40, .42, .65),
    ("queens_village", "suburban", 86, 38, [], 0, 50, .45, .35, .55),
    ("springfield_gardens", "suburban", 82, 48, [], 0, 40, .38, .45, .60),
    ("broad_channel", "waterfront", 72, 78, ["A"], 1, 3, .40, .25, .50),
    ("rockaway_beach", "waterfront", 66, 84, ["A"], 1, 25, .35, .45, .55),
    ("far_rockaway", "projects", 86, 86, ["A"], 1, 60, .30, .55, .60),
]
BROOKLYN = [
    ("greenpoint", "rowhouse", 44, 50, ["G"], 1, 40, .55, .30, .50),
    ("williamsburg", "rowhouse", 44, 54, ["G", "J", "L", "M", "Z"], 1, 130, .55, .35, .60),
    ("east_williamsburg", "industrial", 48, 54, ["G", "L"], 0, 30, .45, .40, .45),
    ("bushwick", "rowhouse", 52, 56, ["J", "L", "M", "Z"], 0, 120, .40, .50, .55),
    ("bed_stuy", "rowhouse", 46, 58, ["A", "C", "G", "J", "Z"], 0, 160, .40, .50, .65),
    ("dumbo", "waterfront", 38, 52, ["A", "C", "F"], 1, 15, .85, .20, .30),
    ("brooklyn_heights", "rowhouse", 37, 54, ["2", "3", "4", "5", "A", "C", "R"], 1, 25, .85, .18, .40),
    ("downtown_brooklyn", "civic", 39, 55, ["2", "3", "4", "5", "A", "C", "F", "R"], 0, 30, .65, .35, .35),
    ("fort_greene", "rowhouse", 41, 56, ["C", "G"], 0, 40, .60, .35, .50),
    ("clinton_hill", "rowhouse", 43, 57, ["C", "G"], 0, 40, .58, .35, .50),
    ("boerum_hill", "rowhouse", 39, 58, ["A", "C", "F", "G"], 0, 25, .65, .30, .40),
    ("carroll_gardens", "rowhouse", 38, 60, ["F", "G"], 0, 40, .70, .25, .45),
    ("red_hook", "waterfront", 36, 62, [], 1, 12, .35, .45, .45),
    ("gowanus", "industrial", 39, 61, ["F", "G", "R"], 1, 25, .50, .40, .35),
    ("park_slope", "rowhouse", 41, 61, ["2", "3", "F", "G", "R"], 0, 70, .75, .22, .45),
    ("prospect_heights", "rowhouse", 43, 59, ["2", "3", "B", "Q"], 0, 35, .65, .30, .45),
    ("crown_heights", "rowhouse", 46, 61, ["2", "3", "4", "5"], 0, 140, .38, .52, .65),
    ("brownsville", "projects", 50, 63, ["3", "L"], 0, 110, .20, .68, .60),
    ("east_new_york", "projects", 54, 62, ["3", "A", "C", "J", "L", "Z"], 0, 110, .22, .65, .55),
    ("cypress_hills", "rowhouse", 56, 58, ["J", "Z"], 0, 45, .30, .55, .55),
    ("canarsie", "rowhouse", 52, 68, ["L"], 1, 85, .35, .45, .55),
    ("east_flatbush", "rowhouse", 47, 66, ["2", "5"], 0, 130, .35, .50, .60),
    ("flatbush", "grid_dense", 44, 66, ["2", "5", "B", "Q"], 0, 150, .40, .45, .65),
    ("kensington", "rowhouse", 42, 66, ["F", "G"], 0, 40, .45, .35, .60),
    ("borough_park", "rowhouse", 40, 68, ["D", "F"], 0, 110, .42, .30, .95),
    ("sunset_park", "rowhouse", 37, 66, ["D", "N", "R"], 1, 120, .40, .40, .60),
    ("bay_ridge", "rowhouse", 35, 72, ["R"], 1, 80, .55, .25, .50),
    ("dyker_heights", "suburban", 38, 73, ["D"], 0, 45, .55, .20, .55),
    ("bensonhurst", "rowhouse", 40, 75, ["D", "N"], 0, 150, .45, .30, .55),
    ("gravesend", "rowhouse", 43, 78, ["F", "N"], 0, 110, .40, .35, .55),
    ("coney_island", "projects", 44, 84, ["D", "F", "N", "Q"], 1, 50, .30, .50, .55),
    ("brighton_beach", "grid_dense", 47, 84, ["B", "Q"], 1, 70, .40, .40, .60),
    ("sheepshead_bay", "rowhouse", 49, 80, ["B", "Q"], 1, 90, .45, .35, .55),
    ("midwood", "rowhouse", 44, 72, ["B", "F", "Q"], 0, 90, .50, .28, .80),
    ("flatlands", "suburban", 50, 72, [], 0, 70, .45, .30, .55),
]
STATEN_ISLAND = [
    ("st_george", "civic", 22, 66, ["SIR"], 1, 30, .45, .40, .50),
    ("west_brighton", "rowhouse", 17, 68, [], 1, 35, .40, .45, .50),
    ("port_richmond", "rowhouse", 13, 68, [], 1, 25, .35, .50, .55),
    ("mariners_harbor", "industrial", 8, 70, [], 1, 25, .30, .50, .50),
    ("stapleton", "rowhouse", 22, 71, ["SIR"], 1, 30, .38, .48, .55),
    ("south_beach", "suburban", 24, 76, [], 1, 25, .45, .35, .50),
    ("todt_hill", "suburban", 17, 76, [], 0, 25, .75, .12, .50),
    ("new_dorp", "suburban", 20, 81, ["SIR"], 1, 30, .55, .25, .50),
    ("great_kills", "suburban", 16, 86, ["SIR"], 1, 40, .55, .22, .50),
    ("tottenville", "suburban", 7, 94, ["SIR"], 1, 25, .60, .18, .50),
]

EDGES = [
    # Manhattan spine
    ("inwood", "washington_heights"), ("washington_heights", "hamilton_heights"),
    ("hamilton_heights", "harlem"), ("hamilton_heights", "morningside_heights"),
    ("harlem", "east_harlem"), ("harlem", "morningside_heights"), ("harlem", "upper_west_side"),
    ("morningside_heights", "upper_west_side"), ("east_harlem", "upper_east_side"),
    ("upper_west_side", "hells_kitchen"), ("upper_east_side", "midtown"),
    ("midtown", "hells_kitchen"), ("midtown", "murray_hill"), ("midtown", "chelsea"), ("midtown", "gramercy"),
    ("hells_kitchen", "chelsea"), ("murray_hill", "gramercy"), ("chelsea", "gramercy"),
    ("chelsea", "greenwich_village"), ("gramercy", "east_village"),
    ("greenwich_village", "east_village"), ("greenwich_village", "soho"),
    ("east_village", "lower_east_side"), ("soho", "tribeca"), ("soho", "chinatown"),
    ("lower_east_side", "chinatown"), ("chinatown", "tribeca"), ("tribeca", "financial_district"),
    ("chinatown", "financial_district"),
    # Bronx
    ("riverdale", "kingsbridge"), ("kingsbridge", "bedford_park"), ("kingsbridge", "norwood"),
    ("norwood", "bedford_park"), ("norwood", "williamsbridge"), ("wakefield", "williamsbridge"),
    ("williamsbridge", "co_op_city"), ("williamsbridge", "morris_park"), ("co_op_city", "pelham_bay"),
    ("bedford_park", "fordham"), ("fordham", "belmont"), ("fordham", "university_heights"),
    ("fordham", "tremont"), ("belmont", "tremont"), ("belmont", "west_farms"),
    ("university_heights", "highbridge"), ("university_heights", "tremont"),
    ("tremont", "west_farms"), ("tremont", "morrisania"), ("west_farms", "soundview"),
    ("west_farms", "parkchester"), ("morris_park", "parkchester"), ("morris_park", "pelham_bay"),
    ("pelham_bay", "throgs_neck"), ("pelham_bay", "city_island"), ("throgs_neck", "castle_hill"),
    ("castle_hill", "parkchester"), ("parkchester", "soundview"), ("castle_hill", "soundview"),
    ("soundview", "hunts_point"), ("highbridge", "concourse"), ("concourse", "melrose"),
    ("concourse", "morrisania"), ("morrisania", "melrose"), ("morrisania", "hunts_point"),
    ("melrose", "mott_haven"), ("mott_haven", "hunts_point"),
    # Queens
    ("astoria", "long_island_city"), ("astoria", "woodside"), ("astoria", "east_elmhurst"),
    ("long_island_city", "sunnyside"), ("sunnyside", "woodside"), ("woodside", "jackson_heights"),
    ("woodside", "maspeth"), ("jackson_heights", "east_elmhurst"), ("jackson_heights", "corona"),
    ("jackson_heights", "elmhurst"), ("east_elmhurst", "corona"), ("elmhurst", "corona"),
    ("corona", "flushing"), ("elmhurst", "rego_park"), ("elmhurst", "maspeth"),
    ("maspeth", "middle_village"), ("maspeth", "ridgewood"), ("ridgewood", "glendale"),
    ("glendale", "middle_village"), ("glendale", "woodhaven"), ("middle_village", "forest_hills"),
    ("rego_park", "forest_hills"), ("forest_hills", "kew_gardens"), ("forest_hills", "flushing"),
    ("kew_gardens", "richmond_hill"), ("kew_gardens", "jamaica"), ("flushing", "college_point"),
    ("college_point", "whitestone"), ("whitestone", "bayside"), ("flushing", "bayside"),
    ("flushing", "fresh_meadows"), ("fresh_meadows", "bayside"), ("fresh_meadows", "jamaica"),
    ("fresh_meadows", "queens_village"), ("jamaica", "hollis"), ("hollis", "queens_village"),
    ("jamaica", "st_albans"), ("st_albans", "springfield_gardens"), ("st_albans", "queens_village"),
    ("jamaica", "richmond_hill"), ("richmond_hill", "woodhaven"), ("richmond_hill", "ozone_park"),
    ("woodhaven", "ozone_park"), ("ozone_park", "howard_beach"), ("ozone_park", "springfield_gardens"),
    ("springfield_gardens", "howard_beach"), ("howard_beach", "broad_channel"),
    ("broad_channel", "rockaway_beach"), ("rockaway_beach", "far_rockaway"),
    # Brooklyn
    ("greenpoint", "williamsburg"), ("williamsburg", "east_williamsburg"), ("williamsburg", "bed_stuy"),
    ("east_williamsburg", "bushwick"), ("bushwick", "bed_stuy"), ("bushwick", "east_new_york"),
    ("bed_stuy", "crown_heights"), ("bed_stuy", "clinton_hill"), ("clinton_hill", "fort_greene"),
    ("clinton_hill", "prospect_heights"), ("fort_greene", "downtown_brooklyn"),
    ("downtown_brooklyn", "brooklyn_heights"), ("downtown_brooklyn", "dumbo"),
    ("downtown_brooklyn", "boerum_hill"), ("brooklyn_heights", "dumbo"),
    ("boerum_hill", "carroll_gardens"), ("boerum_hill", "gowanus"),
    ("carroll_gardens", "red_hook"), ("carroll_gardens", "gowanus"), ("red_hook", "gowanus"),
    ("gowanus", "park_slope"), ("gowanus", "sunset_park"), ("park_slope", "prospect_heights"),
    ("park_slope", "kensington"), ("park_slope", "flatbush"), ("prospect_heights", "crown_heights"),
    ("crown_heights", "brownsville"), ("crown_heights", "east_flatbush"),
    ("brownsville", "east_new_york"), ("brownsville", "canarsie"), ("brownsville", "east_flatbush"),
    ("east_new_york", "canarsie"), ("east_new_york", "cypress_hills"), ("bushwick", "cypress_hills"),
    ("canarsie", "flatlands"), ("east_flatbush", "flatbush"), ("east_flatbush", "flatlands"),
    ("flatbush", "kensington"), ("flatbush", "midwood"), ("kensington", "borough_park"),
    ("kensington", "midwood"), ("borough_park", "sunset_park"), ("borough_park", "bensonhurst"),
    ("borough_park", "midwood"), ("sunset_park", "bay_ridge"), ("bay_ridge", "dyker_heights"),
    ("dyker_heights", "bensonhurst"), ("bensonhurst", "gravesend"), ("gravesend", "coney_island"),
    ("gravesend", "sheepshead_bay"), ("gravesend", "midwood"), ("coney_island", "brighton_beach"),
    ("brighton_beach", "sheepshead_bay"), ("sheepshead_bay", "flatlands"),
    # Staten Island
    ("st_george", "west_brighton"), ("st_george", "stapleton"), ("west_brighton", "port_richmond"),
    ("west_brighton", "todt_hill"), ("port_richmond", "mariners_harbor"),
    ("stapleton", "south_beach"), ("stapleton", "todt_hill"), ("south_beach", "new_dorp"),
    ("todt_hill", "new_dorp"), ("new_dorp", "great_kills"), ("great_kills", "tottenville"),
    ("mariners_harbor", "todt_hill"),
    # Bridges, tunnels, the ferry — the stitching of the city
    ("dumbo", "financial_district"),            # Brooklyn Bridge
    ("dumbo", "chinatown"),                     # Manhattan Bridge
    ("williamsburg", "lower_east_side"),        # Williamsburg Bridge
    ("greenpoint", "long_island_city"),         # Pulaski Bridge
    ("long_island_city", "midtown"),            # Queensboro / Midtown Tunnel
    ("astoria", "east_harlem"),                 # RFK Triborough
    ("inwood", "kingsbridge"),                  # Broadway Bridge
    ("inwood", "riverdale"),                    # Henry Hudson
    ("washington_heights", "highbridge"),       # the old High Bridge itself
    ("washington_heights", "university_heights"),
    ("east_harlem", "mott_haven"),              # Willis Ave Bridge
    ("east_williamsburg", "maspeth"),           # Grand Ave
    ("bushwick", "ridgewood"),                  # the seam of Brooklyn and Queens
    ("cypress_hills", "woodhaven"),
    ("red_hook", "financial_district"),         # the harbor tunnel
    ("bay_ridge", "south_beach"),               # the Verrazzano
    ("st_george", "financial_district"),        # the ferry, while it runs
]

NAME_OVERRIDES = {
    "bed_stuy": "Bed-Stuy", "dumbo": "DUMBO", "co_op_city": "Co-op City",
    "soho": "SoHo", "tribeca": "Tribeca", "st_george": "St. George",
    "st_albans": "St. Albans", "hells_kitchen": "Hell's Kitchen",
}

LANDMARKS = {
    "midtown": [("the_garden", "The Garden", "arena")],
    "concourse": [("bronx_cathedral", "The Bronx Cathedral", "stadium")],
    "corona": [("flushing_bowl", "The Flushing Bowl", "stadium")],
    "prospect_heights": [("atlantic_dome", "The Atlantic Dome", "arena")],
    "park_slope": [("prospect_park", "Prospect Park", "park")],
    "upper_west_side": [("central_park_w", "Central Park", "park")],
    "coney_island": [("lunar_park", "Lunar Park", "boardwalk")],
    "hunts_point": [("night_market", "The Night Market", "market")],
    "red_hook": [("grain_elevator", "The Grain Elevator", "port")],
    "flushing": [("flushing_meadows", "Flushing Meadows", "park")],
    "financial_district": [("battery_hall", "The Battery Ferry Hall", "station")],
    "st_george": [("ferry_terminal", "The Ferry Terminal", "station")],
    "dumbo": [("brooklyn_bridge", "Brooklyn Bridge", "bridge")],
    "harlem": [("the_apollon", "The Apollon", "civic")],
    "sunset_park": [("green_wood", "Green-Wood Cemetery", "cemetery")],
    "middle_village": [("cemetery_belt", "The Cemetery Belt", "cemetery")],
    "pelham_bay": [("pelham_bay_park", "Pelham Bay Park", "park")],
    "rockaway_beach": [("the_boardwalk", "The Boardwalk", "boardwalk")],
    "downtown_brooklyn": [("borough_hall", "Borough Hall", "civic")],
    "morningside_heights": [("the_university", "The University", "campus")],
    "long_island_city": [("drone_yards", "The Drone Yards", "arena")],
    "astoria": [("steinway_works", "The Steinway Works", "campus")],
    "jamaica": [("king_market", "King Market", "market")],
    "bayside": [("fort_totten", "Fort Totten", "civic")],
}

def main():
    boroughs = [
        ("manhattan", MANHATTAN), ("bronx", BRONX), ("queens", QUEENS),
        ("brooklyn", BROOKLYN), ("staten_island", STATEN_ISLAND),
    ]
    adj = {}
    for a, b in EDGES:
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set()).add(a)

    out = []
    ids = set()
    for borough, rows in boroughs:
        for (nid, area, x, y, subway, coastal, popk, prosp, crime, faith) in rows:
            assert nid not in ids, f"duplicate id {nid}"
            ids.add(nid)
            name = NAME_OVERRIDES.get(nid, nid.replace("_", " ").title())
            infra = round(min(0.9, max(0.15, 0.28 + prosp * 0.55 - (0.08 if area == "industrial" else 0))), 2)
            lm = [{"id": l[0], "name": l[1], "kind": l[2]} for l in LANDMARKS.get(nid, [])]
            out.append({
                "id": nid, "name": name, "borough": borough, "area_type": area,
                "pos": [x, y], "adjacent": sorted(adj.get(nid, set())),
                "subway": subway, "coastal": bool(coastal),
                "stats_2026": {
                    "population": popk * 1000, "prosperity": prosp, "crime": crime,
                    "infrastructure": infra, "faith": faith,
                },
                "landmarks": lm,
            })

    # Validate: every edge endpoint exists; graph connected.
    for a, b in EDGES:
        assert a in ids, f"edge endpoint missing: {a}"
        assert b in ids, f"edge endpoint missing: {b}"
    start = next(iter(ids))
    seen = {start}
    q = deque([start])
    while q:
        cur = q.popleft()
        for n in adj.get(cur, ()):
            if n not in seen:
                seen.add(n)
                q.append(n)
    unreachable = ids - seen
    assert not unreachable, f"unreachable: {sorted(unreachable)}"
    isolated = [i for i in ids if i not in adj]
    assert not isolated, f"isolated: {isolated}"

    path = os.path.join(os.path.dirname(__file__), "..", "content", "neighborhoods.json")
    with open(path, "w") as f:
        json.dump({"neighborhoods": out}, f, indent=1, ensure_ascii=False)
    per = {}
    for n in out:
        per[n["borough"]] = per.get(n["borough"], 0) + 1
    print(f"wrote {len(out)} neighborhoods: {per}")

if __name__ == "__main__":
    sys.exit(main())
