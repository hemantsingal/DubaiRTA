# OpenTripPlanner (OTP) for Dubai Transit

This project sets up a local OpenTripPlanner instance for Dubai, allowing you to calculate transit routes using GTFS (schedule) and OSM (map) data. It includes a custom CLI tool (`otp_cli.js`) for easy querying.

## 1. Prerequisites

*   **Java 21**: Required for OTP 2.8.1.
    *   Verify: `java -version`
*   **Node.js**: Required for the CLI tool.
    *   Verify: `node -v`

## 2. Setup Guide

### Directory Structure
Ensure your project directory looks like this:
```
/mongo-docgen
  /data          # Original GTFS text files
  /otp           # OTP working directory
    gtfs.zip     # Zipped GTFS data (Critical!)
    united_arab_emirates.osm.pbf  # Map data
    otp-shaded-2.8.1.jar          # OTP Server
  otp_cli.js     # CLI Tool
  run_otp.ps1    # Startup Script
```

### Step-by-Step Installation

> **Note**: Large files (`.jar`, `.pbf`) and data (`gtfs`) are excluded from this repository. You must download/create them to run the project.

1.  **Download OTP JAR**:
    *   Download `otp-shaded-2.8.1.jar` from Maven Central.
    *   **URL**: [Download Link](https://repo1.maven.org/maven2/org/opentripplanner/otp-shaded/2.8.1/otp-shaded-2.8.1.jar)
    *   Place it in the `otp/` folder.

2.  **Download Map Data (OSM)**:
    *   Download the UAE PBF file (`united_arab_emirates.osm.pbf`).
    *   **URL**: [Download Link](http://download.openstreetmap.fr/extracts/asia/united_arab_emirates.osm.pbf)
    *   Place it in the `otp/` folder.

3.  **Prepare Transit Data (GTFS)**:
    *   Obtain the Dubai GTFS data (e.g., from RTA Open Data).
    *   Place the text files (`routes.txt`, `stops.txt`, etc.) in the `data/` folder (optional, for reference).
    *   **CRITICAL**: Zip all the `.txt` files into a single archive named `gtfs.zip`.
    *   Place `gtfs.zip` in the `otp/` folder.

4.  **Build the Graph**:
    Run the following command to import data and build the routing graph:
    ```powershell
    java -Xmx4G -jar otp/otp-shaded-2.8.1.jar --build --save otp
    ```
    *   *Note: This creates a `graph.obj` file. You only need to do this once (or when data changes).*

## 3. Running the Server

Start the OTP server using the provided PowerShell script:
```powershell
./run_otp.ps1
```
*   The server will start at `http://localhost:8080`.
*   Wait until you see "Grizzly server running".

---

## 4. Using the CLI Tool (`otp_cli.js`)

The `otp_cli.js` tool allows you to find routes from the command line. It uses Google Maps for geocoding and your local OTP server for routing.

### Basic Usage
Find the best route right now:
```bash
node otp_cli.js "Dubai Mall" "Al Nasr Leisureland"
```

### Sample Output (Summary Mode)
```text
🔍 Planning trip for 2025-11-26 at 21:40:27...
📍 Origin: "Union Metro Station"
   -> Resolved: Union Metro Station (25.2663, 55.3145)
📍 Dest:   "BurJuman"
   -> Resolved: Khalid Bin Al Waleed Rd (25.2545, 55.3035)

🚀 Fetching routes...
✅ Found 3 options:

Option 1: 12m (11:13 PM - 11:25 PM)
   Modes: WALK -> SUBWAY -> WALK

Option 2: 12m (11:17 PM - 11:29 PM)
   Modes: WALK -> SUBWAY -> WALK
```

### Sample Output (Verbose Mode)
Use `--verbose` to see exactly which bus to take and how long to wait.

```text
Option 1: 56m (11:16 PM - 12:12 AM)
   Modes: WALK -> SUBWAY -> WALK -> BUS -> WALK
   Stats: Walk: 37m | Wait: 7m
   Details:
      1. 🚶 Walk  - 20m
         11:16 PM Origin
         11:37 PM   Burj Khalifa/ Dubai Mall Metro Station 1
      2. 🚇 Metro (MRed2) - 7m
         11:37 PM Burj Khalifa/ Dubai Mall Metro Station 1
         11:45 PM   max Metro Station 1
      3. 🚶 Walk  - 4m
         11:45 PM max Metro Station 1
         11:49 PM   Max Metro Bus Stop Landside 2
      4. 🚌 Bus (10) - 5m
         11:55 PM Max Metro Bus Stop Landside 2
         12:00 AM   Umm Hurair, Road 1-2
      5. 🚶 Walk  - 11m
         12:00 AM Umm Hurair, Road 1-2
         12:12 AM   Destination
```

---

## 5. CLI Options Reference

| Option | Alias | Default | Description |
| :--- | :--- | :--- | :--- |
| `--time` | `-t` | *Now* | Departure time in `HH:mm` format (e.g., `14:30`). |
| `--date` | `-d` | *Today* | Departure date in `YYYY-MM-DD` format. |
| `--verbose` | `-v` | `false` | Show detailed itinerary, including stops, wait times, and walk/transit stats. |
| `--short` | `-s` | `false` | Show only a quick summary (Duration, Start-End, Modes). |
| `--limit` | | `3` | Number of itineraries to retrieve. Increase this to see more alternatives. |
| `--walk-dist` | | `3000` | Maximum walking distance in meters. Increase this if OTP fails to find a route. |
| `--walk-reluctance`| | `5` | How much to penalize walking. Higher = prefer waiting for bus/metro. Lower = prefer walking. |

---

## 6. Tuning & Optimization

If you aren't getting the results you expect, try adjusting these parameters:

### "No route found" or "Too much walking"
If OTP suggests a 2-hour walk instead of taking the bus, or finds no route at all:
1.  **Increase Max Walk Distance**:
    Sometimes the nearest stop is just outside the default range.
    ```bash
    node otp_cli.js --walk-dist 5000 "Origin" "Dest"
    ```
    *(Sets max walk to 5km)*

2.  **Adjust Walk Reluctance**:
    If OTP refuses to walk 15 mins to a Metro station and instead suggests a 3-bus transfer, **lower** the reluctance.
    ```bash
    node otp_cli.js --walk-reluctance 2 "Origin" "Dest"
    ```
    *(Makes walking "cheaper", so OTP is more willing to suggest it)*

    Conversely, if OTP suggests walking 30 mins to save 5 mins of bus waiting, **raise** the reluctance.
    ```bash
    node otp_cli.js --walk-reluctance 10 "Origin" "Dest"
    ```
    *(Makes walking "expensive", forcing OTP to use transit if possible)*

### "I want to see more options"
By default, OTP returns the top 3 routes. To see up to 10 alternatives:
```bash
node otp_cli.js --limit 10 "Origin" "Dest"
```

### "Check a future trip"
Planning for tomorrow morning?
```bash
node otp_cli.js --date 2025-11-27 --time 08:00 "Sharjah" "Dubai Mall"
```

## 7. Common Issues

*   **"Geocoding failed"**:
    *   Check your internet connection.
    *   Verify the Google Maps API key in `otp_cli.js`.
*   **Server crashes**:
    *   Ensure you have Java 21 installed.
    *   Increase memory in `run_otp.ps1` (e.g., change `-Xmx4G` to `-Xmx8G`).
