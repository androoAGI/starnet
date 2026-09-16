/* New tabletop support geometry; no runtime or saved-layout state. */
'use strict';
const AuthoredSurfaceCalibration = {
  "version": 1,
  "coordinateSpace": "export-normalized",
  "cornerOrder": "TL,TR,BR,BL in screen coordinates before mirroring",
  "qualification": "Measured painted tabletop support regions. Root owns live station acceptance.",
  "props": {
    "industrial_roundtable": {
      "canMirror": true,
      "views": {
        "s": {
          "image": "industrial_roundtable.png",
          "sourceWidth": 1387,
          "sourceHeight": 984,
          "sha256": "ac00ab5bb415f212f398690e614641771a5b56f0741d2d5aa21b65ca57a22503",
          "footprint": {
            "w": 2,
            "h": 1
          },
          "points": [
            [
              0.17,
              0.13
            ],
            [
              0.83,
              0.13
            ],
            [
              0.88,
              0.43
            ],
            [
              0.12,
              0.43
            ]
          ],
          "reference": "docs/station-remaster/batch03/crew/industrial_roundtable.export.json",
          "art": "frontend/assets/industrial/batch03/crew/industrial_roundtable.png",
          "measurement": "Manually inspected current PNG; conservative clear tabletop interior.",
          "bounds": {
            "x": 0,
            "y": -4,
            "width": 24,
            "height": 16
          }
        }
      }
    },
    "sidetable": {
      "canMirror": true,
      "views": {
        "s": {
          "image": "sidetable.png",
          "sourceWidth": 910,
          "sourceHeight": 1182,
          "sha256": "261b792dedc52640f284dc691f82bd9ae4e3d243b4837a440a750769a91ea784",
          "footprint": {
            "w": 1,
            "h": 1
          },
          "points": [
            [
              0.108,
              0.055
            ],
            [
              0.892,
              0.055
            ],
            [
              0.905,
              0.457
            ],
            [
              0.095,
              0.457
            ]
          ],
          "reference": "docs/station-remaster/batch03/crew/sidetable.export.json",
          "art": "frontend/assets/industrial/batch03/crew/sidetable.png",
          "measurement": "Manually inspected current PNG; conservative clear tabletop interior.",
          "bounds": {
            "x": 0,
            "y": -3,
            "width": 12,
            "height": 15
          }
        }
      }
    },
    "lowtable": {
      "canMirror": true,
      "views": {
        "s": {
          "image": "lowtable.png",
          "sourceWidth": 1783,
          "sourceHeight": 620,
          "sha256": "eba90a2ee2c3e773e01e5d235a8b5f5c829b5a6f572ef4ae0882a28af233ca65",
          "footprint": {
            "w": 3,
            "h": 1
          },
          "points": [
            [
              0.088,
              0.067
            ],
            [
              0.912,
              0.067
            ],
            [
              0.94,
              0.416
            ],
            [
              0.06,
              0.416
            ]
          ],
          "reference": "frontend/assets/industrial/props-v3/manifest.json",
          "art": "frontend/assets/industrial/props-v3/lowtable.png",
          "measurement": "Manually inspected current PNG; conservative clear tabletop interior.",
          "bounds": {
            "x": -1,
            "y": -5,
            "width": 38,
            "height": 17
          }
        },
        "e": {
          "image": "lowtable-r3.png",
          "sourceWidth": 637,
          "sourceHeight": 1684,
          "sha256": "c08b11195caf5a6b620c8017f18aff10aeb35b16b368fd089a692984c41537a4",
          "footprint": {
            "w": 1,
            "h": 3
          },
          "points": [
            [
              0.267,
              0.045
            ],
            [
              0.753,
              0.045
            ],
            [
              0.819,
              0.819
            ],
            [
              0.208,
              0.819
            ]
          ],
          "reference": "frontend/assets/industrial/props-v3/manifest.json",
          "art": "frontend/assets/industrial/props-v3/lowtable-r3.png",
          "measurement": "Manually inspected current PNG; conservative clear tabletop interior.",
          "bounds": {
            "x": -2,
            "y": 0,
            "width": 16,
            "height": 36
          }
        }
      }
    },
    "glasstable": {
      "canMirror": true,
      "views": {
        "s": {
          "image": "glasstable.png",
          "sourceWidth": 1706,
          "sourceHeight": 513,
          "sha256": "4c5bb258ff59ba139fb100f4fd4aa2ce8bf0c90e8a04794e92004f42be4c97dd",
          "footprint": {
            "w": 3,
            "h": 1
          },
          "points": [
            [
              0.09,
              0.075
            ],
            [
              0.9,
              0.075
            ],
            [
              0.931,
              0.367
            ],
            [
              0.069,
              0.367
            ]
          ],
          "reference": "docs/station-remaster/batch03/crew/glasstable.export.json",
          "art": "frontend/assets/industrial/batch03/crew/glasstable.png",
          "measurement": "Crew authoredGeometry tableSupport from exact export receipt.",
          "bounds": {
            "x": 0,
            "y": -6,
            "width": 36,
            "height": 18
          }
        },
        "e": {
          "image": "glasstable-r3.png",
          "sourceWidth": 686,
          "sourceHeight": 1775,
          "sha256": "2ea807ffd99482d5d07dbcb23f434dca4b93962d52100764783a40436537d6df",
          "footprint": {
            "w": 1,
            "h": 3
          },
          "points": [
            [
              0.24,
              0.044
            ],
            [
              0.75,
              0.044
            ],
            [
              0.84,
              0.742
            ],
            [
              0.16,
              0.742
            ]
          ],
          "reference": "docs/station-remaster/batch03/crew/glasstable-r3.export.json",
          "art": "frontend/assets/industrial/batch03/crew/glasstable-r3.png",
          "measurement": "Crew authoredGeometry tableSupport from exact export receipt.",
          "bounds": {
            "x": 0,
            "y": 0,
            "width": 12,
            "height": 36
          }
        }
      }
    },
    "loungetable": {
      "canMirror": true,
      "views": {
        "s": {
          "image": "loungetable.png",
          "sourceWidth": 1414,
          "sourceHeight": 608,
          "sha256": "8ff07738bfc4208769cae579d1481ff386d7c9bd55088afc0a66e8863d1af464",
          "footprint": {
            "w": 2,
            "h": 1
          },
          "points": [
            [
              0.085,
              0.018
            ],
            [
              0.9,
              0.018
            ],
            [
              0.962,
              0.456
            ],
            [
              0.035,
              0.456
            ]
          ],
          "reference": "docs/station-remaster/batch03/crew/loungetable.export.json",
          "art": "frontend/assets/industrial/batch03/crew/loungetable.png",
          "measurement": "Crew authoredGeometry tableSupport from exact export receipt.",
          "bounds": {
            "x": 0,
            "y": -6,
            "width": 24,
            "height": 18
          }
        },
        "e": {
          "image": "loungetable-r3.png",
          "sourceWidth": 843,
          "sourceHeight": 1417,
          "sha256": "2f417d8bad9f1ebfda4a6fb5271c79b7a43d5e19eeaea9a2eeaa8fb003a1d9f3",
          "footprint": {
            "w": 1,
            "h": 2
          },
          "points": [
            [
              0.195,
              0.006
            ],
            [
              0.807,
              0.006
            ],
            [
              0.945,
              0.702
            ],
            [
              0.049,
              0.702
            ]
          ],
          "reference": "docs/station-remaster/batch03/crew/loungetable-r3.export.json",
          "art": "frontend/assets/industrial/batch03/crew/loungetable-r3.png",
          "measurement": "Crew authoredGeometry tableSupport from exact export receipt.",
          "bounds": {
            "x": -1,
            "y": 0,
            "width": 14,
            "height": 24
          }
        }
      }
    },
    "longtable": {
      "canMirror": true,
      "views": {
        "s": {
          "image": "longtable.png",
          "sourceWidth": 1762,
          "sourceHeight": 645,
          "sha256": "5cba6e531d62d3ea55ee40cf8c04b1771a2c7166d62b739f6fcda17279dbc64f",
          "footprint": {
            "w": 3,
            "h": 1
          },
          "points": [
            [
              0.075,
              0.025
            ],
            [
              0.92,
              0.025
            ],
            [
              0.955,
              0.37
            ],
            [
              0.04,
              0.37
            ]
          ],
          "reference": "docs/station-remaster/batch03/crew/longtable.export.json",
          "art": "frontend/assets/industrial/batch03/crew/longtable.png",
          "measurement": "Crew authoredGeometry tableSupport from exact export receipt.",
          "bounds": {
            "x": -1,
            "y": -6,
            "width": 38,
            "height": 18
          }
        },
        "e": {
          "image": "longtable-r3.png",
          "sourceWidth": 789,
          "sourceHeight": 1611,
          "sha256": "f717f6428b9e63a93ee6f29926593c1795f702c69e6691e5034cb2a8cb2c669f",
          "footprint": {
            "w": 1,
            "h": 3
          },
          "points": [
            [
              0.229,
              0.026
            ],
            [
              0.771,
              0.026
            ],
            [
              0.865,
              0.657
            ],
            [
              0.125,
              0.657
            ]
          ],
          "reference": "docs/station-remaster/batch03/crew/longtable-r3.export.json",
          "art": "frontend/assets/industrial/batch03/crew/longtable-r3.png",
          "measurement": "Crew authoredGeometry tableSupport from exact export receipt.",
          "bounds": {
            "x": -2,
            "y": 0,
            "width": 16,
            "height": 36
          }
        }
      }
    }
  }
};
