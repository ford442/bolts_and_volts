#ifndef PARTICLE_SYSTEM_HPP
#define PARTICLE_SYSTEM_HPP

#include <cmath>
#include <cstdint>
#include <vector>

#include "Types.hpp"
#include "sim/SimEvent.hpp"

struct Particle {
    Vec2 position;
    Vec2 velocity;
    float life;      // Remaining life in seconds
    float maxLife;   // Total life duration
    float size;
    float rotation;
    float angularVelocity;
};

// xorshift32. Particles are the only consumer; the simulation uses no randomness.
class ParticleRng {
public:
    static constexpr uint32_t DEFAULT_SEED = 0x9E3779B9u;

    explicit ParticleRng(uint32_t seed = DEFAULT_SEED) : state(seed != 0 ? seed : DEFAULT_SEED) {}

    uint32_t next() {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        return state;
    }

    float unit() { return static_cast<float>(next() >> 8) * (1.0f / 16777216.0f); }  // [0, 1)
    float centered() { return unit() - 0.5f; }                                       // [-0.5, 0.5)

private:
    uint32_t state;
};

// Cosmetic only: fed by simulation events (Game::dispatchEvents), never read by the simulation.
class ParticleSystem {
public:
    explicit ParticleSystem(uint32_t seed = ParticleRng::DEFAULT_SEED) : rng(seed) {}

    void update(float deltaTime) {
        for (auto it = particles.begin(); it != particles.end(); ) {
            it->life -= deltaTime;
            if (it->life <= 0) {
                it = particles.erase(it);
            } else {
                it->position.x += it->velocity.x * deltaTime;
                it->position.y += it->velocity.y * deltaTime;
                it->rotation += it->angularVelocity * deltaTime;
                ++it;
            }
        }
    }

    void emit(Vec2 position, Vec2 velocity, float life, float size, float angularVelocity = 0.0f) {
        Particle p;
        p.position = position;
        p.velocity = velocity;
        p.life = life;
        p.maxLife = life;
        p.size = size;
        p.rotation = 0.0f;
        p.angularVelocity = angularVelocity;
        particles.push_back(p);
    }

    // `playerSize` places each burst relative to the player box (feet, mid-body). Random draws are sequenced in
    // named locals: argument evaluation order is unspecified, and replays must not depend on the compiler.
    void onEvent(const SimEvent& event, Vec2 playerSize) {
        const Vec2 at = event.position;
        const Vec2 feet = { at.x, at.y - playerSize.y * 0.5f };
        constexpr float PI = 3.14159f;
        constexpr float TAU = 6.28f;

        switch (event.type) {
            case SimEventType::Jumped:
            case SimEventType::Launched:
                for (int i = 0; i < 10; ++i) {
                    const float angle = rng.unit() * PI;
                    const float speed = 1.0f + rng.unit() * 2.0f;
                    const float spin = rng.centered() * 10.0f;
                    emit(feet, { std::cos(angle) * speed * 0.5f, std::sin(angle) * speed * 0.5f }, 0.5f, 0.1f, spin);
                }
                break;
            case SimEventType::Landed:
                for (int i = 0; i < 10; ++i) {
                    const float angle = rng.unit() * PI;
                    const float speed = 1.0f + rng.unit() * 2.0f;
                    const float spin = rng.centered() * 10.0f;
                    emit(feet, { std::cos(angle) * speed, std::abs(std::sin(angle) * speed * 0.5f) }, 0.3f, 0.08f, spin);
                }
                break;
            case SimEventType::PoundStarted: {
                const Vec2 origin = { at.x, at.y - playerSize.y * 0.4f };
                for (int i = 0; i < 8; ++i) {
                    const float angle = rng.unit() * TAU;
                    const float speed = 1.5f + rng.unit() * 1.5f;
                    const float spin = rng.centered() * 15.0f;
                    emit(origin, { std::cos(angle) * speed * 0.3f, -std::abs(std::sin(angle) * speed) }, 0.4f, 0.12f, spin);
                }
                break;
            }
            case SimEventType::PoundImpact:
                for (int i = 0; i < 14; ++i) {
                    const float angle = rng.unit() * PI;
                    const float speed = 2.0f + rng.unit() * 3.0f;
                    const float spin = rng.centered() * 12.0f;
                    emit(feet, { std::cos(angle) * speed, std::abs(std::sin(angle) * speed * 0.7f) }, 0.5f, 0.12f, spin);
                }
                break;
            case SimEventType::HoverStarted:
                for (int i = 0; i < 6; ++i) {
                    const float angle = rng.unit() * TAU;
                    const float speed = 0.5f + rng.unit() * 0.8f;
                    const float spin = rng.centered() * 20.0f;
                    emit(feet, { std::cos(angle) * speed, std::sin(angle) * speed * 0.4f - 0.5f }, 0.6f, 0.06f, spin);
                }
                break;
            case SimEventType::HoverTick:
                if (rng.unit() < 0.15f) {
                    const float angle = rng.unit() * TAU;
                    const float jitterX = rng.centered() * 0.3f;
                    const float spin = rng.centered() * 10.0f;
                    emit({ feet.x + jitterX, feet.y }, { std::cos(angle) * 0.3f, -0.5f }, 0.3f, 0.04f, spin);
                }
                break;
            case SimEventType::Running:
                if (rng.unit() < 0.10f) {
                    const float lift = 0.5f + rng.unit();
                    const float spin = rng.centered() * 10.0f;
                    emit(feet, { -event.velocity.x * 0.5f, lift }, 0.2f, 0.05f, spin);
                }
                break;
            case SimEventType::CharacterSwitched: {
                const Vec2 origin = { at.x, at.y - playerSize.y * 0.3f };
                for (int i = 0; i < 6; ++i) {
                    const float angle = rng.unit() * TAU;
                    const float speed = 0.8f + rng.unit() * 1.2f;
                    const float spin = rng.centered() * 8.0f;
                    emit(origin, { std::cos(angle) * speed, std::sin(angle) * speed * 0.6f }, 0.35f, 0.07f, spin);
                }
                break;
            }
            case SimEventType::Respawned:
                // A puff where the player was caught (the player is already back at spawn).
                for (int i = 0; i < 16; ++i) {
                    const float angle = rng.unit() * TAU;
                    const float speed = 1.0f + rng.unit() * 2.5f;
                    const float spin = rng.centered() * 12.0f;
                    emit(at, { std::cos(angle) * speed, std::sin(angle) * speed }, 0.45f, 0.1f, spin);
                }
                break;
            case SimEventType::PayloadPickedUp:
            case SimEventType::CheckpointReached:
            case SimEventType::TerminalUsed: {
                const Vec2 origin = { at.x, at.y + playerSize.y * 0.5f };
                for (int i = 0; i < 8; ++i) {
                    const float angle = rng.unit() * PI;
                    const float speed = 0.8f + rng.unit() * 1.2f;
                    const float spin = rng.centered() * 8.0f;
                    emit(origin, { std::cos(angle) * speed, std::sin(angle) * speed }, 0.4f, 0.07f, spin);
                }
                break;
            }
            case SimEventType::GoalReached:
                break;
        }
    }

    const std::vector<Particle>& getParticles() const {
        return particles;
    }

private:
    ParticleRng rng;
    std::vector<Particle> particles;
};

#endif // PARTICLE_SYSTEM_HPP
