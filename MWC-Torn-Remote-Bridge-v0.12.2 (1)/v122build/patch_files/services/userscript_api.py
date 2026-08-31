from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from aiohttp import web

from ui.embeds import calculate_rotation_etas
from services.userscript_auth import UserscriptAuthService, bearer_token

logger = logging.getLogger(__name__)


class UserscriptApiService:
    """Small loopback HTTP bridge for the Torn userscript.

    The bridge binds to loopback by default. Read and write requests are
    thin adapters over the Coordinator services; rotation/assignment/readiness
    decisions stay inside the Coordinator rather than the userscript.
    """

    def __init__(self, bot: Any) -> None:
        self.bot = bot
        self.host = os.getenv("USERSCRIPT_API_HOST", "127.0.0.1").strip() or "127.0.0.1"
        self.port = _env_int("USERSCRIPT_API_PORT", 8765)
        self.enabled = _env_bool("USERSCRIPT_API_ENABLED", True)
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self.auth = UserscriptAuthService(bot)

    async def initialize(self) -> None:
        if not self.enabled:
            logger.info("Userscript API disabled by USERSCRIPT_API_ENABLED.")
            return

        await self.auth.initialize()

        app = web.Application()
        app.router.add_get("/health", self._health)
        app.router.add_post("/api/v1/auth/redeem", self._auth_redeem)
        app.router.add_get("/api/v1/rotation", self._rotation)
        app.router.add_post("/api/v1/rotation/join", self._join_rotation)
        app.router.add_post("/api/v1/rotation/leave", self._leave_rotation)
        app.router.add_post("/api/v1/coordinator/rotation/move", self._coordinator_move)
        app.router.add_post("/api/v1/coordinator/rotation/skip", self._coordinator_skip)
        app.router.add_post("/api/v1/coordinator/rotation/resume", self._coordinator_resume)
        app.router.add_post("/api/v1/coordinator/rotation/remove", self._coordinator_remove)
        app.router.add_post("/api/v1/coordinator/rotation/replace", self._coordinator_replace)
        app.router.add_options("/{tail:.*}", self._options)

        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self.host, self.port)
        await self._site.start()
        logger.info("Userscript API listening on http://%s:%s", self.host, self.port)
        print(f"Userscript API: http://{self.host}:{self.port}")

    async def close(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
        self._runner = None
        self._site = None

    async def _options(self, request: web.Request) -> web.Response:
        return web.Response(status=204, headers=_cors_headers())

    async def _health(self, request: web.Request) -> web.Response:
        return web.json_response(
            {"ok": True, "service": "coordinator-userscript-api", "version": 1},
            headers=_cors_headers(),
        )

    async def _auth_redeem(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
            token, identity = await self.auth.redeem(
                str(body.get("code") or ""),
                str(body.get("device_name") or ""),
            )
            return web.json_response(
                {
                    "ok": True,
                    "token": token,
                    "device_id": identity.device_id,
                    "torn_id": identity.torn_user_id,
                    "name": identity.display_name,
                },
                headers=_cors_headers(),
            )
        except PermissionError as exc:
            return web.json_response(
                {"ok": False, "error": str(exc)}, status=403, headers=_cors_headers()
            )
        except Exception as exc:
            logger.exception("Userscript authentication redemption failed")
            return web.json_response(
                {"ok": False, "error": f"{type(exc).__name__}: {exc}"},
                status=500, headers=_cors_headers(),
            )

    async def _request_identity(self, request: web.Request):
        token = bearer_token(request.headers.get("Authorization"))
        identity = await self.auth.authenticate(token)
        if identity is None:
            raise PermissionError("Userscript authentication is required. Run /userscript link in Discord.")
        return identity

    async def _rotation(self, request: web.Request) -> web.Response:
        try:
            identity = await self._request_identity(request)
            payload = await self.build_rotation_state(viewer_torn_id=identity.torn_user_id)
            payload["viewer"] = {
                "torn_id": identity.torn_user_id,
                "name": identity.display_name,
                "device_id": identity.device_id,
            }
            return web.json_response(payload, headers=_cors_headers())
        except PermissionError as exc:
            return web.json_response(
                {"ok": False, "error": str(exc), "auth_required": True},
                status=401, headers=_cors_headers(),
            )
        except Exception as exc:
            logger.exception("Userscript rotation state failed")
            return web.json_response(
                {"ok": False, "error": f"{type(exc).__name__}: {exc}"},
                status=500, headers=_cors_headers(),
            )


    async def _join_rotation(self, request: web.Request) -> web.Response:
        return await self._rotation_write(request, action="join")

    async def _leave_rotation(self, request: web.Request) -> web.Response:
        return await self._rotation_write(request, action="leave")

    async def _rotation_write(self, request: web.Request, *, action: str) -> web.Response:
        try:
            identity = await self._request_identity(request)
            torn_id = identity.torn_user_id
            message = await self.perform_rotation_action(torn_id=torn_id, action=action)
            payload = await self.build_rotation_state(viewer_torn_id=torn_id)
            payload["action"] = action
            payload["message"] = message
            payload["viewer"] = {"torn_id": torn_id, "name": identity.display_name, "device_id": identity.device_id}
            return web.json_response(payload, headers=_cors_headers())
        except PermissionError as exc:
            return web.json_response(
                {"ok": False, "error": str(exc), "auth_required": True},
                status=401, headers=_cors_headers(),
            )
        except Exception as exc:
            logger.exception("Userscript rotation %s failed", action)
            return web.json_response(
                {"ok": False, "error": f"{type(exc).__name__}: {exc}"},
                status=500, headers=_cors_headers(),
            )

    async def _coordinator_move(self, request: web.Request) -> web.Response:
        return await self._coordinator_rotation_write(request, action="move")

    async def _coordinator_skip(self, request: web.Request) -> web.Response:
        return await self._coordinator_rotation_write(request, action="skip")

    async def _coordinator_resume(self, request: web.Request) -> web.Response:
        return await self._coordinator_rotation_write(request, action="resume")

    async def _coordinator_remove(self, request: web.Request) -> web.Response:
        return await self._coordinator_rotation_write(request, action="remove")

    async def _coordinator_replace(self, request: web.Request) -> web.Response:
        try:
            identity = await self._request_identity(request)
            body = await request.json()
            actor_torn_id = identity.torn_user_id
            raw_order = body.get("ordered_rotation_user_ids")
            if not isinstance(raw_order, list):
                raise ValueError("ordered_rotation_user_ids must be a list.")
            ordered_user_ids = [int(value) for value in raw_order]
        except PermissionError as exc:
            return web.json_response({"ok": False, "error": str(exc), "auth_required": True}, status=401, headers=_cors_headers())
        except (ValueError, TypeError, AttributeError, web.HTTPBadRequest) as exc:
            return web.json_response(
                {"ok": False, "error": f"Invalid rotation order: {exc}"},
                status=400, headers=_cors_headers(),
            )

        try:
            message = await self.perform_coordinator_replace(
                actor_torn_id=actor_torn_id,
                ordered_rotation_user_ids=ordered_user_ids,
            )
            payload = await self.build_rotation_state(viewer_torn_id=actor_torn_id)
            payload["action"] = "replace"
            payload["message"] = message
            return web.json_response(payload, headers=_cors_headers())
        except PermissionError as exc:
            return web.json_response(
                {"ok": False, "error": str(exc)}, status=403, headers=_cors_headers()
            )
        except ValueError as exc:
            return web.json_response(
                {"ok": False, "error": str(exc)}, status=400, headers=_cors_headers()
            )
        except Exception as exc:
            logger.exception("Userscript coordinator rotation replacement failed")
            return web.json_response(
                {"ok": False, "error": f"{type(exc).__name__}: {exc}"},
                status=500, headers=_cors_headers(),
            )

    async def _coordinator_rotation_write(
        self, request: web.Request, *, action: str
    ) -> web.Response:
        try:
            identity = await self._request_identity(request)
            body = await request.json()
            actor_torn_id = identity.torn_user_id
            target_user_id = int(body.get("target_rotation_user_id") or 0)
            position = body.get("position")
        except PermissionError as exc:
            return web.json_response({"ok": False, "error": str(exc), "auth_required": True}, status=401, headers=_cors_headers())
        except (ValueError, TypeError, AttributeError, web.HTTPBadRequest):
            actor_torn_id = 0
            target_user_id = 0
            position = None

        if actor_torn_id <= 0 or target_user_id == 0:
            return web.json_response(
                {"ok": False, "error": "Valid actor and target identities are required."},
                status=400, headers=_cors_headers(),
            )

        try:
            message = await self.perform_coordinator_action(
                actor_torn_id=actor_torn_id,
                target_rotation_user_id=target_user_id,
                action=action,
                position=position,
            )
            payload = await self.build_rotation_state(viewer_torn_id=actor_torn_id)
            payload["action"] = action
            payload["message"] = message
            return web.json_response(payload, headers=_cors_headers())
        except PermissionError as exc:
            return web.json_response(
                {"ok": False, "error": str(exc)}, status=403, headers=_cors_headers()
            )
        except ValueError as exc:
            return web.json_response(
                {"ok": False, "error": str(exc)}, status=400, headers=_cors_headers()
            )
        except Exception as exc:
            logger.exception("Userscript coordinator %s failed", action)
            return web.json_response(
                {"ok": False, "error": f"{type(exc).__name__}: {exc}"},
                status=500, headers=_cors_headers(),
            )

    async def can_manage_rotation(self, torn_id: int | None) -> bool:
        if not torn_id:
            return False
        identity = await self.bot.member_service.get_identity_by_torn(int(torn_id))
        if identity is None or identity.discord_user_id is None:
            return False

        guild = self.bot.get_guild(self.bot.config.guild_id)
        if guild is None:
            return False
        member = guild.get_member(int(identity.discord_user_id))
        if member is None:
            try:
                member = await guild.fetch_member(int(identity.discord_user_id))
            except Exception:
                return False

        role_names = {str(role.name).strip().casefold() for role in getattr(member, "roles", ())}
        configured = {
            str(name).strip().casefold()
            for name in getattr(self.bot.config, "leader_role_names", ())
            if str(name).strip()
        }
        permissions = getattr(member, "guild_permissions", None)
        return bool(role_names & configured) or bool(
            permissions
            and (
                getattr(permissions, "administrator", False)
                or getattr(permissions, "manage_guild", False)
            )
        )

    async def perform_coordinator_action(
        self, *, actor_torn_id: int, target_rotation_user_id: int,
        action: str, position: Any = None
    ) -> str:
        if not await self.can_manage_rotation(actor_torn_id):
            raise PermissionError(
                "Coordinator controls are restricted to configured leaders/server managers."
            )

        members = await self.bot.rotation_service.list_members()
        target = next(
            (item for item in members if item.user_id == int(target_rotation_user_id)),
            None,
        )
        if target is None:
            raise ValueError("That member is no longer in the rotation.")

        action = str(action or "").strip().casefold()
        if action == "move":
            if position is None:
                raise ValueError("Choose a rotation position.")
            message = await self.bot.rotation_service.move_member(
                target.user_id, int(position)
            )
        elif action == "skip":
            message = await self.bot.rotation_service.set_status(target.user_id, "skip")
        elif action == "resume":
            message = await self.bot.rotation_service.set_status(target.user_id, "active")
        elif action == "remove":
            message = await self.bot.rotation_service.remove(
                target.user_id, target.display_name
            )
        else:
            raise ValueError(f"Unsupported coordinator action: {action}")

        self._start_rotation_followup(f"coordinator-{action}")
        await asyncio.sleep(0)
        return message

    async def perform_coordinator_replace(
        self, *, actor_torn_id: int, ordered_rotation_user_ids: list[int]
    ) -> str:
        """Replace the complete current rotation in an explicitly supplied order.

        This intentionally delegates to RotationService.replace_order(), the same
        canonical operation used by Discord's manual rotation replacement command.
        The userscript editor is a reorder tool, so it must contain each current
        rotation member exactly once; it cannot silently add or drop members.
        """
        if not await self.can_manage_rotation(actor_torn_id):
            raise PermissionError(
                "Coordinator controls are restricted to configured leaders/server managers."
            )

        current = await self.bot.rotation_service.list_members()
        if not current:
            raise ValueError("The rotation is currently empty.")
        if not ordered_rotation_user_ids:
            raise ValueError("The replacement rotation cannot be empty.")
        if len(ordered_rotation_user_ids) != len(set(ordered_rotation_user_ids)):
            raise ValueError("Each rotation member can appear only once.")

        current_by_id = {member.user_id: member for member in current}
        current_ids = set(current_by_id)
        supplied_ids = set(int(value) for value in ordered_rotation_user_ids)
        if supplied_ids != current_ids or len(ordered_rotation_user_ids) != len(current):
            raise ValueError(
                "The rotation changed while the editor was open. Close it, reopen Change Rotation, and try again."
            )

        ordered_members = [
            (user_id, current_by_id[user_id].display_name)
            for user_id in ordered_rotation_user_ids
        ]
        message = await self.bot.rotation_service.replace_order(ordered_members)

        standby = getattr(self.bot, "standby_service", None)
        if standby is not None:
            await standby.remove_many(ordered_rotation_user_ids)

        self._start_rotation_followup("coordinator-replace")
        await asyncio.sleep(0)
        return message

    async def perform_rotation_action(self, *, torn_id: int, action: str) -> str:
        """Apply the same canonical rotation mutation used by Discord commands.

        The Torn ID is resolved through MemberService first. This prevents the
        browser from inventing a separate rotation identity and also supports
        manually registered Torn-only identities through ``rotation_user_id``.
        """
        identity = await self.bot.member_service.get_identity_by_torn(int(torn_id))
        if identity is None:
            raise PermissionError(
                "Your Torn account is not registered with this Coordinator yet."
            )
        if not identity.active_for_war:
            raise PermissionError(
                "Your Coordinator profile is not active for war participation."
            )

        action = str(action or "").strip().casefold()
        rotation_user_id = int(identity.rotation_user_id)
        display_name = str(identity.display_name or f"Player {torn_id}")

        if action == "join":
            message = await self.bot.rotation_service.add_or_reactivate(
                rotation_user_id, display_name
            )
            standby = getattr(self.bot, "standby_service", None)
            if standby is not None:
                await standby.remove_if_present(rotation_user_id)
        elif action == "leave":
            message = await self.bot.rotation_service.remove(
                rotation_user_id, display_name
            )
        else:
            raise ValueError(f"Unsupported rotation action: {action}")

        # The membership write itself is the user-facing action and should
        # return quickly. Assignment refreshes, alerts, and Discord dashboard
        # rendering can involve external API/Discord work and previously made
        # the browser POST exceed its timeout even after the join succeeded.
        self._start_rotation_followup(action)
        # Let immediately-completing test doubles/background work get a turn
        # without making the HTTP response wait on real network operations.
        await asyncio.sleep(0)

        return message

    def _start_rotation_followup(self, action: str) -> None:
        task = asyncio.create_task(
            self._rotation_followup(action),
            name=f"userscript-rotation-{action}-followup",
        )
        self._background_tasks.add(task)
        task.add_done_callback(self._rotation_followup_done)

    def _rotation_followup_done(self, task: asyncio.Task[Any]) -> None:
        self._background_tasks.discard(task)
        if task.cancelled():
            return
        try:
            task.result()
        except Exception:
            logger.exception("Userscript rotation follow-up failed")

    async def _rotation_followup(self, action: str) -> None:
        # Rotation membership changes invalidate the target plan. Refresh the
        # canonical assignment store and Discord surfaces asynchronously so
        # the Torn userscript receives a prompt acknowledgement.
        assignment_engine = getattr(self.bot, "tactical_assignment_engine", None)
        if assignment_engine is not None:
            await assignment_engine.refresh(
                force=True, trigger=f"userscript:{action}"
            )

        guild = self.bot.get_guild(self.bot.config.guild_id)
        if guild is not None:
            channel = await self.bot.message_service.get_channel(guild)
            await self.bot.alert_engine.position_alerts(channel)
            try:
                await self.bot.message_service.refresh_rotation(guild)
            except RuntimeError:
                await self.bot.message_service.setup_dashboard(guild)

    async def build_rotation_state(
        self, *, viewer_torn_id: int | None = None
    ) -> dict[str, Any]:
        rotation_members = list(await self.bot.rotation_service.list_members())
        active_members = [m for m in rotation_members if m.status == "active"]
        identities = await self.bot.member_service.list_identities()
        identity_by_rotation_id = {identity.rotation_user_id: identity for identity in identities}

        chain_seconds = await self.bot.message_service._get_chain_seconds()
        try:
            rules = await self.bot.war_rules_service.get_rules()
            hit_time_seconds = int(rules.hit_time_seconds)
        except (RuntimeError, TypeError, ValueError, AttributeError):
            hit_time_seconds = None

        etas = calculate_rotation_etas(
            len(active_members),
            chain_seconds=chain_seconds,
            hit_time_seconds=hit_time_seconds,
        )
        eta_by_user_id = {
            member.user_id: (etas[index] if index < len(etas) else None)
            for index, member in enumerate(active_members)
        }
        active_ordinal = {member.user_id: index for index, member in enumerate(active_members)}

        discord_ids = [member.user_id for member in rotation_members if member.user_id > 0]
        readiness_by_user_id: dict[int, Any] = {}
        if discord_ids:
            summary = await self.bot.readiness_manager.get_faction(
                discord_ids,
                force=False,
                allow_stale_on_error=True,
            )
            readiness_by_user_id = {item.discord_user_id: item for item in summary.members}

        assignments_by_user_id: dict[int, Any] = {}
        snapshot = self.bot.tactical_assignment_engine.store.current()
        if snapshot is None and active_members:
            try:
                snapshot = await self.bot.tactical_assignment_engine.refresh(
                    force=False,
                    trigger="userscript:first-read",
                )
            except Exception:
                logger.exception("Initial userscript assignment refresh failed")
                snapshot = self.bot.tactical_assignment_engine.store.current()
        if snapshot is not None:
            assignments_by_user_id = {
                item.member_user_id: item for item in snapshot.assignments
            }

        output_members: list[dict[str, Any]] = []
        for member in rotation_members:
            profile = (
                await self.bot.member_service.get_profile(member.user_id)
                if member.user_id > 0
                else None
            )
            identity = identity_by_rotation_id.get(member.user_id)
            readiness = readiness_by_user_id.get(member.user_id)
            assignment = assignments_by_user_id.get(member.user_id)
            recommendation = assignment.recommendation if assignment is not None else None
            target = getattr(recommendation, "target", None)

            ordinal = active_ordinal.get(member.user_id)
            role = None
            if ordinal == 0:
                role = "up"
            elif ordinal == 1:
                role = "on-deck"
            elif ordinal == 2:
                role = "in-hole"

            life_percent = None
            if readiness is not None:
                life_percent = readiness.life.percent

            output_members.append(
                {
                    # JavaScript cannot safely represent Discord snowflakes as
                    # Numbers. Send the canonical rotation identity as a string
                    # for all write actions. Keep discord_user_id for backwards
                    # compatibility with older userscripts.
                    "rotation_user_id": str(member.user_id),
                    "discord_user_id": member.user_id,
                    "torn_id": (
                        profile.torn_user_id
                        if profile is not None
                        else (identity.torn_user_id if identity is not None else None)
                    ),
                    "name": (
                        profile.torn_name
                        if profile is not None
                        else (identity.display_name if identity is not None else member.display_name)
                    ),
                    "position": member.position,
                    "rotation_status": member.status,
                    "role": role,
                    "eta_seconds": eta_by_user_id.get(member.user_id),
                    "target": (
                        {
                            "id": int(target.torn_id),
                            "name": str(target.name),
                            "attack_url": str(target.attack_url),
                            "profile_url": str(target.profile_url),
                        }
                        if target is not None
                        else None
                    ),
                    "energy": (readiness.energy.current if readiness is not None else None),
                    "health_percent": (round(life_percent, 1) if life_percent is not None else None),
                    "status": (
                        readiness.status.state
                        or readiness.state.value.replace("_", " ").title()
                        if readiness is not None
                        else "Unknown"
                    ),
                    "readiness_state": (readiness.state.value if readiness is not None else "unknown"),
                }
            )

        return {
            "ok": True,
            "version": 2,
            "permissions": {
                "manage_rotation": await self.can_manage_rotation(viewer_torn_id),
                "change_target": False,
            },
            "chain_seconds": chain_seconds,
            "hit_time_seconds": hit_time_seconds,
            "members": output_members,
            "assignment_version": (snapshot.version if snapshot is not None else 0),
        }


def _cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "https://www.torn.com",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Cache-Control": "no-store",
    }


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().casefold() in {"1", "true", "yes", "on", "enabled"}


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if 1 <= value <= 65535 else default


def _optional_positive_int(value: Any) -> int | None:
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None
