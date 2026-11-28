#ifndef SIM_EVENT_HPP
#define SIM_EVENT_HPP

#include "../Types.hpp"

// Something that happened during a Simulation call. Consumers (particles, sound, the level-complete callback in
// Game) react to these; the simulation never reads them back, so nothing cosmetic can affect collision.
enum class SimEventType {
    Jumped,            // left the ground, or the coyote window, at jump strength
    Landed,            // first tick of ground contact after being airborne
    PoundStarted,      // Bolts ground pound began (airborne only)
    PoundImpact,       // a ground pound still active on landing; same tick as Landed
    HoverStarted,      // Volts hover began (airborne only)
    HoverTick,         // one tick of hover gravity was applied
    Running,           // one grounded tick with horizontal speed
    CharacterSwitched,
    GoalReached,       // first overlap with a goal (while carrying the payload, if the level has one); once per goal per level load
    Respawned,         // touched an enabled hazard; position is where, the player is already back at the respawn point
    PayloadPickedUp,   // first overlap with the payload since it was last on its pad
    TerminalUsed,      // Volts used a terminal (its target hazard, if any, is now disabled)
    CheckpointReached, // entered a checkpoint it was not already inside; `index` says which, and it is now the respawn point
    Launched,          // entered a launcher it was not already inside; `index` says which; velocity is already the launcher's
};

struct SimEvent {
    SimEventType type;
    Vec2 position;  // player centre when the event happened
    Vec2 velocity;  // player velocity when the event happened
    int index = -1; // CheckpointReached / Launched: the checkpoint's or launcher's index in the level; -1 otherwise
};

#endif // SIM_EVENT_HPP
