// Native tests for the platformer core (cpp/src/sim). `npm run test:sim` builds this file plus
// cpp/src/sim/Simulation.cpp with the host compiler (scripts/test-sim.sh): no emsdk, no browser, no particles.
// Each tick drives the simulation the way src/game/loop.ts drives Game: handleInput(keys), then update(1/60).

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <algorithm>
#include <cmath>
#include <vector>

#include "sim/Simulation.hpp"

namespace {

constexpr float DT = 1.0f / 60.0f;

constexpr InputState IDLE{false, false, false, false};
constexpr InputState LEFT{true, false, false, false};
constexpr InputState RIGHT{false, true, false, false};
constexpr InputState JUMP{false, false, true, false};
constexpr InputState ABILITY{false, false, false, true};

using Events = std::vector<SimEvent>;

int count(const Events& events, SimEventType type) {
    return static_cast<int>(std::count_if(events.begin(), events.end(),
                                          [type](const SimEvent& e) { return e.type == type; }));
}

bool has(const Events& events, SimEventType type) { return count(events, type) > 0; }

Events drain(Simulation& sim) {
    Events events;
    sim.drainEvents(events);
    return events;
}

// One fixed tick, as the game loop runs it. Returns the events it produced.
Events tick(Simulation& sim, const InputState& input = IDLE) {
    sim.handleInput(input);
    sim.update(DT);
    return drain(sim);
}

Platform box(float x, float y, float w, float h) { return {{x, y}, {w, h}}; }

float topOf(const Platform& p) { return p.position.y + p.size.y * 0.5f; }

float feet(const Simulation& sim) { return sim.player().position.y - sim.player().size.y * 0.5f; }

// Gravity for one tick that is not hovering, per the apex rule in Types.hpp.
float plainGravityStep(float vyBefore) {
    const float mult = std::abs(vyBefore) < Physics::APEX_VELOCITY_THRESHOLD ? Physics::APEX_GRAVITY_MULT : 1.0f;
    return Physics::GRAVITY * mult * DT;
}

// A 40-wide floor, 0.2 thick, top at y = 0.1. Default spawn is 0.1 above it.
LevelSpec floorLevel(Vec2 spawn = {0.0f, 0.6f}) {
    LevelSpec level;
    level.spawn = spawn;
    level.platforms = {box(0.0f, 0.0f, 40.0f, 0.2f)};
    return level;
}

Simulation load(const LevelSpec& level) {
    Simulation sim;
    sim.loadLevel(level);
    return sim;
}

void settle(Simulation& sim) {
    for (int i = 0; i < 240 && !sim.player().grounded; ++i) tick(sim);
    REQUIRE(sim.player().grounded);
}

// On a ledge spanning x in [-5, 5] (top 0.1): walk right off the end and stay airborne for `airborneTicks` ticks.
Simulation walkedOff(int airborneTicks) {
    LevelSpec level;
    level.spawn = Vec2{4.0f, 0.6f};
    level.platforms = {box(0.0f, 0.0f, 10.0f, 0.2f)};
    Simulation sim = load(level);
    settle(sim);
    for (int guard = 0; sim.player().grounded; ++guard) {
        REQUIRE(guard < 120);
        tick(sim, RIGHT);
    }
    for (int i = 1; i < airborneTicks; ++i) tick(sim, RIGHT);
    REQUIRE_FALSE(sim.player().grounded);
    return sim;
}

// Number of ticks (1-based) until the Landed event, for a dry run of `sim`.
int ticksUntilLanding(Simulation sim) {
    for (int t = 1; t <= 600; ++t) {
        if (has(tick(sim), SimEventType::Landed)) return t;
    }
    FAIL("never landed");
    return -1;
}

// Rise from standing with jump held; returns the highest feet position above the takeoff point.
float apexAboveTakeoff(bool volts) {
    Simulation sim = load(floorLevel());
    if (volts) sim.switchCharacter();
    settle(sim);
    const float start = feet(sim);
    float best = start;
    tick(sim, JUMP);
    while (!sim.player().grounded) {
        best = std::max(best, feet(sim));
        tick(sim, JUMP);
    }
    return best - start;
}

} // namespace

TEST_CASE("standing on a platform does not sink or float") {
    Simulation sim = load(floorLevel());
    const float floorTop = topOf(sim.platforms()[0]);
    int landings = 0;
    for (int i = 0; i < 30 && !sim.player().grounded; ++i) landings += count(tick(sim), SimEventType::Landed);
    REQUIRE(sim.player().grounded);
    CHECK(landings == 1);

    for (int i = 0; i < 600; ++i) {
        CAPTURE(i);
        const Events events = tick(sim);
        REQUIRE(sim.player().grounded);
        REQUIRE_FALSE(has(events, SimEventType::Landed));
        REQUIRE(feet(sim) == doctest::Approx(floorTop));
        REQUIRE(sim.player().velocity.y == 0.0f);
    }
}

TEST_CASE("walking off a ledge starts coyote time, then falls") {
    Simulation sim = walkedOff(1);
    const PlayerBody& body = sim.player();
    CHECK(body.position.x - body.size.x * 0.5f > 5.0f - 1e-3f);  // the body has cleared the edge
    CHECK(sim.coyoteTimer() == doctest::Approx(Physics::COYOTE_TIME - DT));  // counting down from the first airborne tick

    float lastY = body.position.y;
    float lastCoyote = sim.coyoteTimer();
    for (int i = 0; i < 30; ++i) {
        CAPTURE(i);
        tick(sim);
        REQUIRE_FALSE(body.grounded);
        REQUIRE(body.velocity.y < 0.0f);
        REQUIRE(body.position.y < lastY);
        if (lastCoyote > 0.0f) REQUIRE(sim.coyoteTimer() < lastCoyote);
        lastY = body.position.y;
        lastCoyote = sim.coyoteTimer();
    }
    CHECK(sim.coyoteTimer() <= 0.0f);
    CHECK(feet(sim) < 0.1f - 1.0f);
}

TEST_CASE("coyote time") {
    SUBCASE("a jump inside the window still leaves the ground") {
        Simulation sim = walkedOff(3);  // 0.05 s after leaving, COYOTE_TIME is 0.12 s
        REQUIRE(sim.coyoteTimer() > 0.0f);
        const float y = sim.player().position.y;
        const Events events = tick(sim, JUMP);
        CHECK(count(events, SimEventType::Jumped) == 1);
        CHECK(sim.player().velocity.y == doctest::Approx(sim.jumpStrength()));
        CHECK(sim.player().position.y > y);
        CHECK(sim.coyoteTimer() == 0.0f);
    }
    SUBCASE("a jump after the window does nothing") {
        Simulation sim = walkedOff(12);  // 0.2 s
        REQUIRE(sim.coyoteTimer() <= 0.0f);
        const Events events = tick(sim, JUMP);
        CHECK_FALSE(has(events, SimEventType::Jumped));
        CHECK(sim.player().velocity.y < 0.0f);
    }
}

TEST_CASE("a takeoff is not a landing and grants no coyote time") {
    Simulation sim = load(floorLevel());
    settle(sim);
    const Events takeoff = tick(sim, JUMP);
    CHECK(count(takeoff, SimEventType::Jumped) == 1);
    CHECK_FALSE(has(takeoff, SimEventType::Landed));
    CHECK_FALSE(sim.player().grounded);
    CHECK(sim.coyoteTimer() == 0.0f);

    // Release and press again while still rising: no second jump.
    tick(sim, IDLE);
    REQUIRE(sim.player().velocity.y > 0.0f);
    CHECK_FALSE(has(tick(sim, JUMP), SimEventType::Jumped));
}

TEST_CASE("jump pressed just before landing fires on the first grounded tick") {
    const LevelSpec level = floorLevel({0.0f, 2.0f});
    const int landingTick = ticksUntilLanding(load(level));  // the simulation is deterministic
    REQUIRE(landingTick > 15);

    SUBCASE("inside JUMP_BUFFER_TIME") {
        const int lead = 3;  // pressed 0.05 s before contact; the buffer is 0.1 s
        Simulation sim = load(level);
        for (int t = 1; t < landingTick - lead; ++t) tick(sim);
        for (int t = landingTick - lead; t < landingTick; ++t) REQUIRE_FALSE(has(tick(sim, JUMP), SimEventType::Jumped));
        const Events contact = tick(sim, JUMP);
        REQUIRE(has(contact, SimEventType::Landed));
        const Events next = tick(sim, JUMP);
        CHECK(count(next, SimEventType::Jumped) == 1);
        CHECK(sim.player().velocity.y == doctest::Approx(sim.jumpStrength()));
        CHECK_FALSE(sim.player().grounded);
    }
    SUBCASE("too early is dropped") {
        const int lead = 12;  // 0.2 s
        Simulation sim = load(level);
        for (int t = 1; t < landingTick - lead; ++t) tick(sim);
        for (int t = landingTick - lead; t < landingTick; ++t) tick(sim, JUMP);
        REQUIRE(has(tick(sim, JUMP), SimEventType::Landed));
        for (int i = 0; i < 10; ++i) {
            CAPTURE(i);
            REQUIRE_FALSE(has(tick(sim, JUMP), SimEventType::Jumped));
            REQUIRE(sim.player().grounded);
        }
    }
}

TEST_CASE("releasing jump while rising scales vy by JUMP_CUT_MULTIPLIER once") {
    Simulation sim = load(floorLevel());
    settle(sim);
    for (int i = 0; i < 5; ++i) tick(sim, JUMP);
    const float rising = sim.player().velocity.y;
    REQUIRE(rising > 0.0f);

    SUBCASE("cut on release, then only gravity") {
        sim.handleInput(IDLE);
        CHECK(sim.player().velocity.y == doctest::Approx(rising * Physics::JUMP_CUT_MULTIPLIER));
        sim.update(DT);
        for (int i = 0; i < 20 && !sim.player().grounded; ++i) {
            CAPTURE(i);
            const float before = sim.player().velocity.y;
            sim.handleInput(IDLE);
            REQUIRE(sim.player().velocity.y == before);
            sim.update(DT);
        }
    }
    SUBCASE("no cut when released while falling") {
        while (sim.player().velocity.y > 0.0f) tick(sim, JUMP);
        const float falling = sim.player().velocity.y;
        sim.handleInput(IDLE);
        CHECK(sim.player().velocity.y == falling);
    }
}

TEST_CASE("Bolts ground pound") {
    SUBCASE("in the air it sets vy to BOLTS_GROUND_POUND_SPEED, and lands as an impact") {
        Simulation sim = load(floorLevel({0.0f, 3.0f}));
        REQUIRE(sim.character() == CharacterType::Bolts);
        tick(sim);
        tick(sim);
        REQUIRE_FALSE(sim.player().grounded);

        sim.handleInput(ABILITY);
        CHECK(sim.player().velocity.y == CharacterStats::BOLTS_GROUND_POUND_SPEED);
        CHECK(sim.abilityState() == AbilityState::Active);
        CHECK(count(drain(sim), SimEventType::PoundStarted) == 1);
        sim.update(DT);
        drain(sim);

        Events landing;
        for (int i = 0; i < 60 && !has(landing, SimEventType::Landed); ++i) landing = tick(sim);
        REQUIRE(has(landing, SimEventType::Landed));
        CHECK(count(landing, SimEventType::PoundImpact) == 1);
        CHECK(sim.abilityState() == AbilityState::Cooldown);
        CHECK(feet(sim) == doctest::Approx(topOf(sim.platforms()[0])));
    }
    SUBCASE("on the ground it does nothing") {
        Simulation sim = load(floorLevel());
        settle(sim);
        sim.handleInput(ABILITY);
        CHECK(sim.player().velocity.y == 0.0f);
        CHECK(sim.abilityState() == AbilityState::Ready);
        CHECK_FALSE(has(drain(sim), SimEventType::PoundStarted));
        sim.update(DT);
        CHECK(sim.player().grounded);
    }
    SUBCASE("jump and ability on the same grounded tick only jumps") {
        Simulation sim = load(floorLevel());
        settle(sim);
        const Events events = tick(sim, InputState{false, false, true, true});
        CHECK(count(events, SimEventType::Jumped) == 1);
        CHECK_FALSE(has(events, SimEventType::PoundStarted));
        CHECK(sim.abilityState() == AbilityState::Ready);
        CHECK(sim.player().velocity.y == doctest::Approx(sim.jumpStrength()));
    }
}

TEST_CASE("Volts hover multiplies gravity by VOLTS_HOVER_GRAVITY_MULT only while active and airborne") {
    SUBCASE("in the air, for the hover duration") {
        Simulation sim = load(floorLevel({0.0f, 30.0f}));
        sim.switchCharacter();
        drain(sim);
        REQUIRE(sim.character() == CharacterType::Volts);
        for (int i = 0; i < 5; ++i) tick(sim);

        sim.handleInput(ABILITY);
        REQUIRE(sim.abilityState() == AbilityState::Active);
        REQUIRE(count(drain(sim), SimEventType::HoverStarted) == 1);

        // Gravity is the hover gravity on exactly the ticks that report HoverTick, and plain gravity otherwise.
        int hoverTicks = 0;
        int plainTicks = 0;
        for (int i = 0; i < 120; ++i) {
            CAPTURE(i);
            const float before = sim.player().velocity.y;
            if (i > 0) sim.handleInput(IDLE);
            sim.update(DT);
            const Events events = drain(sim);
            REQUIRE_FALSE(sim.player().grounded);
            const float step = sim.player().velocity.y - before;
            if (has(events, SimEventType::HoverTick)) {
                ++hoverTicks;
                REQUIRE(plainTicks == 0);  // one contiguous hover window
                REQUIRE(step == doctest::Approx(Physics::GRAVITY * CharacterStats::VOLTS_HOVER_GRAVITY_MULT * DT));
            } else {
                ++plainTicks;
                REQUIRE(step == doctest::Approx(plainGravityStep(before)));
            }
        }
        CHECK(std::abs(hoverTicks - static_cast<int>(CharacterStats::VOLTS_HOVER_DURATION / DT)) <= 1);
        CHECK(sim.abilityState() == AbilityState::Cooldown);
    }
    SUBCASE("landing ends it") {
        Simulation sim = load(floorLevel({0.0f, 1.5f}));
        sim.switchCharacter();
        tick(sim);
        tick(sim);
        tick(sim, ABILITY);
        REQUIRE(sim.abilityState() == AbilityState::Active);
        Events landing;
        for (int i = 0; i < 120 && !has(landing, SimEventType::Landed); ++i) landing = tick(sim);
        REQUIRE(has(landing, SimEventType::Landed));
        CHECK(sim.abilityState() == AbilityState::Cooldown);
        CHECK_FALSE(has(tick(sim), SimEventType::HoverTick));
    }
    SUBCASE("on the ground it does nothing") {
        Simulation sim = load(floorLevel());
        sim.switchCharacter();
        settle(sim);
        const Events events = tick(sim, ABILITY);
        CHECK(sim.abilityState() == AbilityState::Ready);
        CHECK_FALSE(has(events, SimEventType::HoverStarted));
        CHECK_FALSE(has(events, SimEventType::HoverTick));
    }
}

TEST_CASE("overlapping a goal fires the complete signal once") {
    LevelSpec level = floorLevel();
    level.goals = {box(3.0f, 0.6f, 1.0f, 1.0f)};  // x in [2.5, 3.5], resting player height
    Simulation sim = load(level);
    settle(sim);

    int signals = 0;
    float maxX = sim.player().position.x;
    for (int i = 0; i < 120; ++i) {
        signals += count(tick(sim, RIGHT), SimEventType::GoalReached);
        maxX = std::max(maxX, sim.player().position.x);
    }
    for (int i = 0; i < 120; ++i) signals += count(tick(sim, LEFT), SimEventType::GoalReached);
    REQUIRE(maxX > 4.0f);                       // walked through the goal...
    REQUIRE(sim.player().position.x < 2.0f);    // ...and back through it
    CHECK(signals == 1);

    sim.loadLevel(level);  // a reload re-arms it
    settle(sim);
    signals = 0;
    for (int i = 0; i < 120; ++i) signals += count(tick(sim, RIGHT), SimEventType::GoalReached);
    CHECK(signals == 1);
}

TEST_CASE("camera x stays inside bounds when follow runs past the edge") {
    LevelSpec level = floorLevel();
    level.bounds = LevelBounds{{-3.0f, -5.0f}, {4.0f, 5.0f}};
    Simulation sim = load(level);
    settle(sim);

    for (int i = 0; i < 300; ++i) {
        CAPTURE(i);
        tick(sim, RIGHT);
        REQUIRE(sim.camera().x <= 4.0f);
        REQUIRE(sim.camera().x >= -3.0f);
    }
    CHECK(sim.player().position.x > 8.0f);
    CHECK(sim.camera().x == 4.0f);  // pinned to the edge, not just lagging behind

    for (int i = 0; i < 600; ++i) {
        CAPTURE(i);
        tick(sim, LEFT);
        REQUIRE(sim.camera().x <= 4.0f);
        REQUIRE(sim.camera().x >= -3.0f);
    }
    CHECK(sim.player().position.x < -7.0f);
    CHECK(sim.camera().x == -3.0f);
}

TEST_CASE("switching character resets the ability to ready") {
    Simulation sim = load(floorLevel({0.0f, 3.0f}));
    tick(sim);
    tick(sim, ABILITY);
    REQUIRE(sim.abilityState() == AbilityState::Active);

    SUBCASE("from active") {
        sim.switchCharacter();
        CHECK(sim.character() == CharacterType::Volts);
        CHECK(sim.abilityState() == AbilityState::Ready);
        CHECK(sim.abilityCooldownPercent() == 0.0f);
        CHECK(count(drain(sim), SimEventType::CharacterSwitched) == 1);
    }
    SUBCASE("from cooldown") {
        settle(sim);
        REQUIRE(sim.abilityState() == AbilityState::Cooldown);
        REQUIRE(sim.abilityCooldownPercent() > 0.0f);
        sim.switchCharacter();
        CHECK(sim.abilityState() == AbilityState::Ready);
        CHECK(sim.abilityCooldownPercent() == 0.0f);
    }
}

TEST_CASE("a long fall onto a 0.2-thick platform lands on it, on the tick of contact") {
    for (const float drop : {3.0f, 10.0f, 30.0f, 60.0f, 100.0f}) {
        for (const bool pound : {false, true}) {
            CAPTURE(drop);
            CAPTURE(pound);
            Simulation sim = load(floorLevel({0.0f, 0.5f + drop}));  // feet `drop` above the top
            const float floorTop = topOf(sim.platforms()[0]);
            if (pound) {
                tick(sim);
                tick(sim, ABILITY);
                REQUIRE(sim.abilityState() == AbilityState::Active);
            }

            float lastFeet = feet(sim);
            bool landed = false;
            for (int i = 0; i < 600 && !landed; ++i) {
                // A pound lasts BOLTS_GROUND_POUND_DURATION (~6.8 units of fall), so long drops land after it expired.
                const bool poundActive = sim.abilityState() == AbilityState::Active;
                const Events events = tick(sim);
                if (has(events, SimEventType::Landed)) {
                    landed = true;
                    CHECK(lastFeet > floorTop + 1e-4f);  // still in the air at the end of the previous tick
                    CHECK(feet(sim) == doctest::Approx(floorTop));
                    CHECK(has(events, SimEventType::PoundImpact) == poundActive);
                }
                lastFeet = feet(sim);
            }
            REQUIRE(landed);
            for (int i = 0; i < 30; ++i) {
                tick(sim);
                REQUIRE(sim.player().grounded);
                REQUIRE(feet(sim) == doctest::Approx(floorTop));
            }
        }
    }
}

TEST_CASE("resting contact is not a collision") {
    // After landing, `feet == top` only up to float rounding. Without a contact tolerance, at some heights the
    // horizontal pass sees the floor as overlapping and shoves the player to its nearest edge.
    SUBCASE("standing and walking on floors at many heights") {
        for (int i = 0; i < 400; ++i) {
            for (const float thickness : {0.2f, 0.22f, 0.25f}) {
                const float y = -3.0f + static_cast<float>(i) * 0.0173f;
                CAPTURE(y);
                CAPTURE(thickness);
                LevelSpec level;
                level.spawn = Vec2{-19.5f, y + thickness * 0.5f + 0.45f};
                level.platforms = {box(30.0f, y, 110.0f, thickness)};  // x in [-25, 85], like the real levels
                Simulation sim = load(level);
                settle(sim);
                for (int t = 0; t < 30; ++t) {
                    const float x = sim.player().position.x;
                    tick(sim, RIGHT);
                    REQUIRE(sim.player().grounded);
                    REQUIRE(sim.player().position.x > x);
                    REQUIRE(sim.player().position.x - x < 0.1f);
                }
            }
        }
    }
    SUBCASE("landing on test-1's spawn floor, plain or pounding, stays put") {
        // public/levels/test-1.json: floor at y = -3, 0.4 thick, spawn (-2, -1.5). Its resting height rounds the
        // wrong way, and the pound landing used to eject the player to the platform edge (old AGENTS.md issue).
        for (const bool pound : {false, true}) {
            CAPTURE(pound);
            LevelSpec level;
            level.spawn = Vec2{-2.0f, -1.5f};
            level.platforms = {box(0.0f, -3.0f, 12.0f, 0.4f)};
            Simulation sim = load(level);
            if (pound) {
                tick(sim);
                tick(sim, ABILITY);
                REQUIRE(sim.abilityState() == AbilityState::Active);
            }
            settle(sim);
            for (int t = 0; t < 60; ++t) {
                tick(sim);
                REQUIRE(sim.player().grounded);
                REQUIRE(sim.player().position.x == -2.0f);
            }
        }
    }
    SUBCASE("walking across a seam between two platforms does not snag") {
        LevelSpec level;
        level.spawn = Vec2{-2.0f, 0.6f};
        level.platforms = {box(-5.0f, 0.0f, 10.0f, 0.2f), box(5.0f, 0.0f, 10.0f, 0.2f)};  // meet at x = 0
        Simulation sim = load(level);
        settle(sim);
        for (int i = 0; i < 30; ++i) tick(sim, RIGHT);  // up to speed
        while (sim.player().position.x < 2.0f) {
            const float x = sim.player().position.x;
            tick(sim, RIGHT);
            REQUIRE(sim.player().grounded);
            REQUIRE(sim.player().velocity.x == doctest::Approx(sim.moveSpeed()));
            REQUIRE(sim.player().position.x > x);
        }
    }
    SUBCASE("pushing into a wall keeps the player on the floor beside it") {
        LevelSpec level = floorLevel();
        level.platforms.push_back(box(2.0f, 1.1f, 1.0f, 2.0f));  // wall from x = 1.5, standing on the floor
        Simulation sim = load(level);
        settle(sim);
        const float floorTop = topOf(sim.platforms()[0]);
        for (int i = 0; i < 120; ++i) tick(sim, RIGHT);
        for (int i = 0; i < 60; ++i) {
            CAPTURE(i);
            tick(sim, RIGHT);
            REQUIRE(sim.player().grounded);
            REQUIRE(feet(sim) == doctest::Approx(floorTop));
            REQUIRE(sim.player().position.x + sim.player().size.x * 0.5f == doctest::Approx(1.5f));
        }
    }
}

TEST_CASE("jump apex heights match the tuned feel") {
    // Highest feet position above the takeoff point with jump held, from a standing start. The values are what the
    // integrator produced before the sim split (same takeoff and flight); the levels are built around them.
    // Update them only when retuning on purpose.
    CHECK(apexAboveTakeoff(false) == doctest::Approx(0.909271f).epsilon(1e-4));
    CHECK(apexAboveTakeoff(true) == doctest::Approx(1.129966f).epsilon(1e-4));
}

TEST_CASE("the same inputs replay to the same state") {
    LevelSpec level = floorLevel({-6.0f, 0.6f});
    level.platforms.push_back(box(0.0f, 1.2f, 2.0f, 0.2f));
    level.goals = {box(1.5f, 0.6f, 1.0f, 1.0f)};
    level.bounds = LevelBounds{{-5.0f, -5.0f}, {6.0f, 5.0f}};

    // Back and forth over the floor (x stays within about [-6, 3]), jumping, pounding / hovering, switching.
    const auto run = [&level](Events& log) {
        Simulation sim = load(level);
        for (int t = 0; t < 900; ++t) {
            const int phase = t % 150;
            InputState in = (t / 200) % 2 == 0 ? RIGHT : LEFT;
            in.jump = phase >= 20 && phase < 32;
            in.abilityKey = phase == 45;
            if (t == 300 || t == 600) sim.switchCharacter();
            const Events events = tick(sim, in);
            log.insert(log.end(), events.begin(), events.end());
        }
        return sim;
    };

    Events logA;
    Events logB;
    const Simulation a = run(logA);
    const Simulation b = run(logB);
    REQUIRE(logA.size() == logB.size());
    for (std::size_t i = 0; i < logA.size(); ++i) {
        CAPTURE(i);
        REQUIRE(logA[i].type == logB[i].type);
        REQUIRE(logA[i].position.x == logB[i].position.x);
        REQUIRE(logA[i].position.y == logB[i].position.y);
    }
    CHECK(a.player().position.x == b.player().position.x);
    CHECK(a.player().position.y == b.player().position.y);
    CHECK(a.camera().x == b.camera().x);
    // The script really exercised the mechanics.
    CHECK(count(logA, SimEventType::Jumped) >= 5);
    CHECK(count(logA, SimEventType::PoundStarted) >= 1);
    CHECK(count(logA, SimEventType::HoverStarted) >= 1);
    CHECK(count(logA, SimEventType::GoalReached) == 1);
}

// --- Courier entities: hazards, payload, terminals -------------------------------------------------------------

namespace {

Hazard staticHazard(float x, float y, float w, float h) { return Hazard{{x, y}, {w, h}, x, x, 0.0f, true, 1.0f}; }

Hazard patrolHazard(float x, float y, float w, float h, float x0, float x1, float speed) {
    return Hazard{{x, y}, {w, h}, x0, x1, speed, true, 1.0f};
}

// Sitting on floorLevel's floor (top 0.1).
Payload payloadAt(float x) { return Payload{{x, 0.3f}, {0.4f, 0.4f}, {0.0f, 0.0f}, false}; }

Terminal terminalAt(float x, int target) { return Terminal{{x, 0.5f}, {0.6f, 0.8f}, target, false}; }

// Walk right (or left) until `type` fires; returns that tick's events. Fails after `limit` ticks.
Events walkUntil(Simulation& sim, SimEventType type, const InputState& input = RIGHT, int limit = 600) {
    for (int i = 0; i < limit; ++i) {
        Events events = tick(sim, input);
        if (has(events, type)) return events;
    }
    FAIL("event never fired");
    return {};
}

void requireCarriedOnTop(const Simulation& sim) {
    REQUIRE(sim.payload().has_value());
    const Payload& payload = *sim.payload();
    const PlayerBody& body = sim.player();
    REQUIRE(payload.carried);
    REQUIRE(payload.position.x == body.position.x);
    REQUIRE(payload.position.y == doctest::Approx(body.position.y + (body.size.y + payload.size.y) * 0.5f));
}

} // namespace

TEST_CASE("touching a hazard puts the player back at spawn, at rest") {
    LevelSpec level = floorLevel();
    level.hazards = {staticHazard(3.0f, 0.4f, 0.6f, 0.6f)};
    Simulation sim = load(level);
    settle(sim);

    const Events events = walkUntil(sim, SimEventType::Respawned);
    CHECK(count(events, SimEventType::Respawned) == 1);
    const SimEvent hit = *std::find_if(events.begin(), events.end(), [](const SimEvent& e) { return e.type == SimEventType::Respawned; });
    CHECK(hit.position.x > 3.0f - 0.6f);  // reported where it happened...
    CHECK(sim.player().position.x == 0.0f);  // ...but the player is already back
    CHECK(sim.player().position.y == 0.6f);
    CHECK(sim.player().velocity.x == 0.0f);
    CHECK(sim.player().velocity.y == 0.0f);
    CHECK(sim.hazards()[0].enabled);  // hazards keep their state

    settle(sim);  // and it plays on from there
    CHECK(sim.player().position.x == 0.0f);
}

TEST_CASE("a static hazard (speed 0) does not move, a patrol stays inside [x0, x1] and turns at both ends") {
    LevelSpec level = floorLevel({-15.0f, 0.6f});
    level.hazards = {
        staticHazard(8.0f, 0.4f, 0.8f, 0.6f),
        patrolHazard(3.0f, 0.4f, 0.8f, 0.6f, 2.0f, 4.0f, 1.5f),
        patrolHazard(9.0f, 0.4f, 0.8f, 0.6f, 12.0f, 10.0f, -2.0f),  // reversed endpoints, negative speed, start outside
    };
    Simulation sim = load(level);
    CHECK(sim.hazards()[2].x0 == 10.0f);
    CHECK(sim.hazards()[2].x1 == 12.0f);
    CHECK(sim.hazards()[2].position.x == 10.0f);  // clamped into the range

    float minX = 1e9f;
    float maxX = -1e9f;
    for (int i = 0; i < 600; ++i) {
        CAPTURE(i);
        tick(sim);
        REQUIRE(sim.hazards()[0].position.x == 8.0f);
        for (std::size_t h = 1; h < 3; ++h) {
            const Hazard& hazard = sim.hazards()[h];
            REQUIRE(hazard.position.x >= hazard.x0);
            REQUIRE(hazard.position.x <= hazard.x1);
            REQUIRE(hazard.position.y == 0.4f);
        }
        minX = std::min(minX, sim.hazards()[1].position.x);
        maxX = std::max(maxX, sim.hazards()[1].position.x);
    }
    CHECK(minX == 2.0f);
    CHECK(maxX == 4.0f);
}

TEST_CASE("the payload is picked up on overlap and rides on top of the player, through a jump") {
    LevelSpec level = floorLevel();
    level.payload = payloadAt(2.0f);
    Simulation sim = load(level);
    settle(sim);
    REQUIRE_FALSE(sim.payload()->carried);
    CHECK(sim.payload()->origin.x == 2.0f);

    const Events pickup = walkUntil(sim, SimEventType::PayloadPickedUp);
    CHECK(count(pickup, SimEventType::PayloadPickedUp) == 1);
    requireCarriedOnTop(sim);

    tick(sim, JUMP);
    REQUIRE_FALSE(sim.player().grounded);
    float highest = sim.player().position.y;
    int ticks = 0;
    while (!sim.player().grounded) {
        REQUIRE(++ticks < 120);
        const Events events = tick(sim, InputState{false, true, true, false});
        CHECK_FALSE(has(events, SimEventType::PayloadPickedUp));  // never dropped and picked up again
        requireCarriedOnTop(sim);
        highest = std::max(highest, sim.player().position.y);
    }
    CHECK(highest > 0.5f + 0.5f);
    for (int i = 0; i < 30; ++i) {
        tick(sim, LEFT);
        requireCarriedOnTop(sim);
    }
}

TEST_CASE("with a payload in the level, the goal fires only while it is carried, and once") {
    LevelSpec level = floorLevel();
    level.goals = {box(3.0f, 0.6f, 1.0f, 1.0f)};  // x in [2.5, 3.5]
    level.payload = payloadAt(6.0f);
    Simulation sim = load(level);
    settle(sim);

    int signals = 0;
    bool pickedUp = false;
    while (!pickedUp) {
        const Events events = tick(sim, RIGHT);
        signals += count(events, SimEventType::GoalReached);
        pickedUp = has(events, SimEventType::PayloadPickedUp);
        REQUIRE(sim.player().position.x < 8.0f);
    }
    REQUIRE(sim.player().position.x > 4.0f);  // walked through the goal empty-handed
    CHECK(signals == 0);

    for (int i = 0; i < 240; ++i) signals += count(tick(sim, LEFT), SimEventType::GoalReached);
    REQUIRE(sim.player().position.x < 2.0f);  // back through it, carrying
    CHECK(signals == 1);
    for (int i = 0; i < 240; ++i) signals += count(tick(sim, RIGHT), SimEventType::GoalReached);
    CHECK(signals == 1);
}

TEST_CASE("respawning drops the payload back on its pad") {
    LevelSpec level = floorLevel();
    level.payload = payloadAt(2.0f);
    level.hazards = {staticHazard(5.0f, 0.4f, 0.6f, 0.6f)};
    Simulation sim = load(level);
    settle(sim);

    walkUntil(sim, SimEventType::PayloadPickedUp);
    REQUIRE(sim.payload()->carried);
    walkUntil(sim, SimEventType::Respawned);
    CHECK_FALSE(sim.payload()->carried);
    CHECK(sim.payload()->position.x == 2.0f);
    CHECK(sim.payload()->position.y == 0.3f);

    // Not carried until touched again: standing at spawn leaves it on the pad.
    for (int i = 0; i < 60; ++i) {
        tick(sim);
        REQUIRE_FALSE(sim.payload()->carried);
        REQUIRE(sim.payload()->position.x == 2.0f);
    }
    walkUntil(sim, SimEventType::PayloadPickedUp);
    CHECK(sim.payload()->carried);

    sim.loadLevel(level);  // a reload resets it too
    CHECK_FALSE(sim.payload()->carried);
    CHECK(sim.payload()->position.x == 2.0f);
}

TEST_CASE("a terminal under Volts disables its hazard; under Bolts it does nothing") {
    LevelSpec level = floorLevel({2.0f, 0.6f});  // standing on the terminal
    level.terminals = {terminalAt(2.0f, 1)};
    level.hazards = {staticHazard(-6.0f, 0.4f, 0.6f, 0.6f), staticHazard(6.0f, 0.4f, 0.6f, 0.6f)};

    SUBCASE("Bolts: nothing, and a grounded Bolts press is not a pound either") {
        Simulation sim = load(level);
        settle(sim);
        const Events events = tick(sim, ABILITY);
        CHECK_FALSE(has(events, SimEventType::TerminalUsed));
        CHECK_FALSE(sim.terminals()[0].used);
        CHECK(sim.hazards()[1].enabled);
        CHECK(sim.abilityState() == AbilityState::Ready);
        CHECK(has(walkUntil(sim, SimEventType::Respawned), SimEventType::Respawned));  // the hazard still bites
    }
    SUBCASE("Volts: the targeted hazard goes off, the ability is untouched, the way is clear") {
        Simulation sim = load(level);
        sim.switchCharacter();
        settle(sim);
        const Events events = tick(sim, ABILITY);
        CHECK(count(events, SimEventType::TerminalUsed) == 1);
        CHECK_FALSE(has(events, SimEventType::HoverStarted));
        CHECK(sim.terminals()[0].used);
        CHECK_FALSE(sim.hazards()[1].enabled);
        CHECK(sim.hazards()[0].enabled);  // only the target
        CHECK(sim.abilityState() == AbilityState::Ready);

        for (int i = 0; i < 240; ++i) REQUIRE_FALSE(has(tick(sim, RIGHT), SimEventType::Respawned));
        CHECK(sim.player().position.x > 8.0f);
    }
    SUBCASE("Volts in the air over it: the press is the terminal's, not a hover") {
        Simulation sim = load(level);
        sim.switchCharacter();
        settle(sim);
        tick(sim, JUMP);
        tick(sim, IDLE);
        tick(sim, IDLE);
        REQUIRE_FALSE(sim.player().grounded);
        const Events events = tick(sim, ABILITY);
        CHECK(count(events, SimEventType::TerminalUsed) == 1);
        CHECK_FALSE(has(events, SimEventType::HoverStarted));
        CHECK(sim.abilityState() == AbilityState::Ready);
        CHECK_FALSE(sim.hazards()[1].enabled);
    }
}

TEST_CASE("the terminal shares the ability key without stealing it") {
    LevelSpec level = floorLevel({-2.0f, 0.6f});
    level.terminals = {terminalAt(0.0f, 0)};  // x in [-0.3, 0.3]
    level.hazards = {staticHazard(6.0f, 0.4f, 0.6f, 0.6f)};
    Simulation sim = load(level);
    sim.switchCharacter();
    settle(sim);

    // Airborne away from the terminal, E is still hover.
    tick(sim, JUMP);
    for (int i = 0; i < 5; ++i) tick(sim, IDLE);
    const Events hover = tick(sim, ABILITY);
    CHECK(count(hover, SimEventType::HoverStarted) == 1);
    CHECK_FALSE(has(hover, SimEventType::TerminalUsed));
    CHECK_FALSE(sim.terminals()[0].used);
    settle(sim);
    REQUIRE(sim.abilityState() == AbilityState::Cooldown);

    // Walk onto the terminal while hover is still cooling down: the terminal works anyway.
    while (sim.player().position.x < -0.1f) tick(sim, RIGHT);
    for (int i = 0; i < 10; ++i) tick(sim, IDLE);
    REQUIRE(std::abs(sim.player().position.x) < 0.5f);
    REQUIRE(sim.abilityState() == AbilityState::Cooldown);
    CHECK(count(tick(sim, ABILITY), SimEventType::TerminalUsed) == 1);
    CHECK_FALSE(sim.hazards()[0].enabled);
    CHECK(sim.abilityState() == AbilityState::Cooldown);  // not reset, not consumed

    // A used terminal hands the key back to the ability.
    for (int i = 0; i < 150 && sim.abilityState() != AbilityState::Ready; ++i) tick(sim, IDLE);
    REQUIRE(sim.abilityState() == AbilityState::Ready);
    tick(sim, JUMP);
    tick(sim, IDLE);
    const Events again = tick(sim, ABILITY);
    CHECK(count(again, SimEventType::HoverStarted) == 1);
    CHECK_FALSE(has(again, SimEventType::TerminalUsed));
}
