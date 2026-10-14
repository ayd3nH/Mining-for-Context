-- Mining for Context gameplay migration
-- Run once in Supabase SQL Editor. Keeps game_content inaccessible to ordinary browser SELECTs.

alter table public.game_rooms
  add column if not exists mfc_rounds_total integer not null default 5,
  add column if not exists mfc_selection_seconds integer not null default 60,
  add column if not exists mfc_voting_seconds integer not null default 15,
  add column if not exists mfc_mode text not null default 'different_images_different_messages';

create table if not exists public.mfc_rounds (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  round_number integer not null,
  phase text not null default 'selecting' check (phase in ('selecting','voting','results','finished')),
  selection_deadline timestamptz not null,
  voting_deadline timestamptz,
  created_at timestamptz not null default now(),
  unique(room_id, round_number)
);

create table if not exists public.mfc_round_hands (
  round_id uuid not null references public.mfc_rounds(id) on delete cascade,
  player_id uuid not null references public.game_players(id) on delete cascade,
  hand jsonb not null,
  primary key(round_id, player_id)
);

create table if not exists public.mfc_submissions (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.mfc_rounds(id) on delete cascade,
  player_id uuid not null references public.game_players(id) on delete cascade,
  pair_slot integer not null check (pair_slot in (1,2)),
  image_content_id uuid not null references public.game_content(id),
  message_content_id uuid not null references public.game_content(id),
  created_at timestamptz not null default now(),
  unique(round_id, player_id, pair_slot)
);

create table if not exists public.mfc_votes (
  round_id uuid not null references public.mfc_rounds(id) on delete cascade,
  voter_id uuid not null references public.game_players(id) on delete cascade,
  submission_id uuid not null references public.mfc_submissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(round_id, voter_id)
);

create table if not exists public.mfc_scores (
  room_id uuid not null references public.game_rooms(id) on delete cascade,
  player_id uuid not null references public.game_players(id) on delete cascade,
  points integer not null default 0,
  primary key(room_id, player_id)
);

alter table public.mfc_rounds enable row level security;
alter table public.mfc_round_hands enable row level security;
alter table public.mfc_submissions enable row level security;
alter table public.mfc_votes enable row level security;
alter table public.mfc_scores enable row level security;
-- No direct table policies: access goes through the SECURITY DEFINER RPCs below.

create or replace function public.mfc_is_room_player(target_room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.game_players p where p.room_id = target_room and p.id = auth.uid());
$$;

create or replace function public.mfc_create_round(target_room uuid, target_round integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_room public.game_rooms%rowtype;
  v_round uuid;
  v_player record;
  v_shared_images jsonb;
  v_shared_messages jsonb;
  v_images jsonb;
  v_messages jsonb;
  v_img_count integer;
  v_msg_count integer;
begin
  select * into v_room from public.game_rooms where id = target_room for update;
  if not found then raise exception 'Room not found.'; end if;
  if not exists(select 1 from public.game_players where room_id=target_room and id=auth.uid() and is_host) then
    raise exception 'Only the host can start a round.';
  end if;
  select count(*) into v_img_count from public.game_content where content_type='image' and image_url is not null;
  select count(*) into v_msg_count from public.game_content where content_type='message' and content_text is not null and char_length(trim(content_text)) - char_length(replace(trim(content_text),' ','')) >= 5;
  if v_img_count < 2 or v_msg_count < 5 then raise exception 'Not enough content for a round.'; end if;

  insert into public.mfc_rounds(room_id,round_number,phase,selection_deadline)
  values(target_room,target_round,'selecting',now() + make_interval(secs => v_room.mfc_selection_seconds)) returning id into v_round;

  if v_room.mfc_mode in ('same_images_different_messages','different_images_same_messages') then
    select jsonb_agg(x) into v_shared_images from (
      select jsonb_build_object('id',id,'url',image_url) x from public.game_content
      where content_type='image' and image_url is not null order by random() limit 2
    ) q;
  end if;
  if v_room.mfc_mode = 'different_images_same_messages' then
    select jsonb_agg(x) into v_shared_messages from (
      select jsonb_build_object('id',id,'text',content_text) x from public.game_content
      where content_type='message' and content_text is not null
        and array_length(regexp_split_to_array(trim(content_text), '\s+'),1) > 5
      order by random() limit 5
    ) q;
  end if;

  for v_player in select id from public.game_players where room_id=target_room loop
    if v_room.mfc_mode = 'same_images_different_messages' then
      v_images := v_shared_images;
    else
      select jsonb_agg(x) into v_images from (
        select jsonb_build_object('id',id,'url',image_url) x from public.game_content
        where content_type='image' and image_url is not null order by random() limit 2
      ) q;
    end if;
    if v_room.mfc_mode = 'different_images_same_messages' then
      v_messages := v_shared_messages;
    else
      select jsonb_agg(x) into v_messages from (
        select jsonb_build_object('id',id,'text',content_text) x from public.game_content
        where content_type='message' and content_text is not null
          and array_length(regexp_split_to_array(trim(content_text), '\s+'),1) > 5
        order by random() limit 5
      ) q;
    end if;
    insert into public.mfc_round_hands(round_id,player_id,hand)
    values(v_round,v_player.id,jsonb_build_object('images',coalesce(v_images,'[]'::jsonb),'messages',coalesce(v_messages,'[]'::jsonb)));
  end loop;
  return v_round;
end;
$$;

create or replace function public.mfc_start_game(target_room uuid, rounds_total integer default 5, selection_seconds integer default 60, voting_seconds integer default 15, game_mode text default 'different_images_different_messages')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_room public.game_rooms%rowtype; v_round uuid;
begin
  select * into v_room from public.game_rooms where id=target_room for update;
  if not found or not exists(select 1 from public.game_players where room_id=target_room and id=auth.uid() and is_host) then raise exception 'Only the host can start this room.'; end if;
  if v_room.scan_status <> 'ready' then raise exception 'Content is not ready yet.'; end if;
  if v_room.status <> 'lobby' then raise exception 'This game has already started.'; end if;
  if rounds_total not between 1 and 30 then raise exception 'Choose between 1 and 30 rounds.'; end if;
  if selection_seconds not between 10 and 180 or voting_seconds not between 10 and 120 then raise exception 'Invalid timer setting.'; end if;
  if game_mode not in ('same_images_different_messages','different_images_different_messages','different_images_same_messages') then raise exception 'Invalid game mode.'; end if;
  update public.game_rooms set status='playing', mfc_rounds_total=rounds_total, mfc_selection_seconds=selection_seconds, mfc_voting_seconds=voting_seconds, mfc_mode=game_mode where id=target_room;
  insert into public.mfc_scores(room_id,player_id,points) select target_room,id,0 from public.game_players where room_id=target_room on conflict do nothing;
  v_round := public.mfc_create_round(target_room,1);
  return jsonb_build_object('round_id',v_round,'round_number',1);
end;
$$;

create or replace function public.mfc_submit_combos(target_room uuid, pairs jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_round public.mfc_rounds%rowtype; v_pair jsonb; v_hand jsonb; v_player uuid := auth.uid(); v_i integer := 0;
begin
  if not public.mfc_is_room_player(target_room) then raise exception 'You are not in this room.'; end if;
  select * into v_round from public.mfc_rounds where room_id=target_room and phase='selecting' order by round_number desc limit 1;
  if not found or now() > v_round.selection_deadline then raise exception 'The selection time has ended.'; end if;
  select hand into v_hand from public.mfc_round_hands where round_id=v_round.id and player_id=v_player;
  if jsonb_typeof(pairs) <> 'array' or jsonb_array_length(pairs) <> 2 then raise exception 'Submit exactly two image/message pairs.'; end if;
  delete from public.mfc_submissions where round_id=v_round.id and player_id=v_player;
  for v_pair in select value from jsonb_array_elements(pairs) loop
    v_i := v_i + 1;
    if not exists(select 1 from jsonb_array_elements(v_hand->'images') x where x->>'id'=v_pair->>'image_id') then raise exception 'That image is not in your hand.'; end if;
    if not exists(select 1 from jsonb_array_elements(v_hand->'messages') x where x->>'id'=v_pair->>'message_id') then raise exception 'That message is not in your hand.'; end if;
    insert into public.mfc_submissions(round_id,player_id,pair_slot,image_content_id,message_content_id)
    values(v_round.id,v_player,v_i,(v_pair->>'image_id')::uuid,(v_pair->>'message_id')::uuid);
  end loop;
end;
$$;

create or replace function public.mfc_vote(target_room uuid, target_submission uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_round public.mfc_rounds%rowtype; v_owner uuid;
begin
  if not public.mfc_is_room_player(target_room) then raise exception 'You are not in this room.'; end if;
  select * into v_round from public.mfc_rounds where room_id=target_room and phase='voting' order by round_number desc limit 1;
  if not found or now() > v_round.voting_deadline then raise exception 'Voting has ended.'; end if;
  select player_id into v_owner from public.mfc_submissions where id=target_submission and round_id=v_round.id;
  if v_owner is null then raise exception 'Submission not found.'; end if;
  if v_owner=auth.uid() then raise exception 'You cannot vote for your own combo.'; end if;
  insert into public.mfc_votes(round_id,voter_id,submission_id) values(v_round.id,auth.uid(),target_submission)
  on conflict(round_id,voter_id) do update set submission_id=excluded.submission_id, created_at=now();
end;
$$;

create or replace function public.mfc_get_game_state(target_room uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_round public.mfc_rounds%rowtype; v_hand jsonb; v_state jsonb; v_me uuid := auth.uid(); v_room public.game_rooms%rowtype;
begin
  if not public.mfc_is_room_player(target_room) then raise exception 'You are not in this room.'; end if;
  select * into v_room from public.game_rooms where id=target_room;
  select * into v_round from public.mfc_rounds where room_id=target_room order by round_number desc limit 1;
  if not found then return jsonb_build_object('status',v_room.status,'phase','waiting'); end if;

  if v_round.phase='selecting' and (
    now() >= v_round.selection_deadline
    or not exists (
      select 1 from public.game_players p
      where p.room_id = target_room
        and (select count(*) from public.mfc_submissions s
             where s.round_id = v_round.id and s.player_id = p.id) < 2
    )
  ) then
    update public.mfc_rounds set phase='voting', voting_deadline=now() + make_interval(secs => v_room.mfc_voting_seconds) where id=v_round.id returning * into v_round;
  elsif v_round.phase='voting' and now() >= v_round.voting_deadline then
    update public.mfc_rounds set phase='results' where id=v_round.id returning * into v_round;
    with tally as (
      select s.id, s.player_id, count(v.voter_id)::int votes
      from public.mfc_submissions s left join public.mfc_votes v on v.submission_id=s.id and v.round_id=v_round.id
      where s.round_id=v_round.id group by s.id, s.player_id
    ), ranked as (
      select id, player_id, votes, dense_rank() over(order by votes desc) rank
      from tally
    )
    insert into public.mfc_scores(room_id,player_id,points)
    select target_room, player_id, case when rank=1 then 3 when rank=2 then 1 else 0 end
    from ranked where votes > 0 and rank <= 2
    on conflict(room_id,player_id) do update set points=public.mfc_scores.points+excluded.points;
  end if;

  select hand into v_hand from public.mfc_round_hands where round_id=v_round.id and player_id=v_me;
  select jsonb_build_object(
    'status',v_room.status,
    'room_code',v_room.code,
    'mode',v_room.mfc_mode,
    'rounds_total',v_room.mfc_rounds_total,
    'selection_seconds',v_room.mfc_selection_seconds,
    'voting_seconds',v_room.mfc_voting_seconds,
    'round',jsonb_build_object('id',v_round.id,'number',v_round.round_number,'phase',v_round.phase,'selection_deadline',v_round.selection_deadline,'voting_deadline',v_round.voting_deadline),
    'hand',coalesce(v_hand,'{}'::jsonb),
    'submissions',case when v_round.phase in ('voting','results','finished') then coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'player_id',s.player_id,'username',case when v_round.phase in ('results','finished') then p.username else null end,'pair_slot',s.pair_slot,'image_url',i.image_url,'message_text',m.content_text,'votes',(select count(*) from public.mfc_votes vv where vv.submission_id=s.id))) from public.mfc_submissions s join public.game_players p on p.id=s.player_id join public.game_content i on i.id=s.image_content_id join public.game_content m on m.id=s.message_content_id where s.round_id=v_round.id),'[]'::jsonb) else '[]'::jsonb end,
    'my_submitted',exists(select 1 from public.mfc_submissions where round_id=v_round.id and player_id=v_me),
    'my_vote', (select submission_id from public.mfc_votes where round_id=v_round.id and voter_id=v_me),
    'scores',coalesce((select jsonb_agg(jsonb_build_object('player_id',p.id,'username',p.username,'points',coalesce(sc.points,0)) order by coalesce(sc.points,0) desc) from public.game_players p left join public.mfc_scores sc on sc.player_id=p.id and sc.room_id=target_room where p.room_id=target_room),'[]'::jsonb),
    'is_host',exists(select 1 from public.game_players where room_id=target_room and id=v_me and is_host),
    'all_submitted',not exists(select 1 from public.game_players p where p.room_id=target_room and not exists(select 1 from public.mfc_submissions s where s.round_id=v_round.id and s.player_id=p.id group by s.player_id having count(*)=2))
  ) into v_state;
  return v_state;
end;
$$;

create or replace function public.mfc_next_round(target_room uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_room public.game_rooms%rowtype; v_round public.mfc_rounds%rowtype; v_next integer; v_new uuid;
begin
  select * into v_room from public.game_rooms where id=target_room for update;
  if not exists(select 1 from public.game_players where room_id=target_room and id=auth.uid() and is_host) then raise exception 'Only the host can advance the game.'; end if;
  select * into v_round from public.mfc_rounds where room_id=target_room order by round_number desc limit 1;
  if not found or v_round.phase <> 'results' then raise exception 'This round is not finished yet.'; end if;
  v_next := v_round.round_number + 1;
  if v_next > v_room.mfc_rounds_total then
    update public.game_rooms set status='finished' where id=target_room;
    update public.mfc_rounds set phase='finished' where id=v_round.id;
    return jsonb_build_object('finished',true);
  end if;
  v_new := public.mfc_create_round(target_room,v_next);
  return jsonb_build_object('finished',false,'round_id',v_new,'round_number',v_next);
end;
$$;

revoke all on function public.mfc_is_room_player(uuid) from public;
revoke all on function public.mfc_create_round(uuid,integer) from public;
grant execute on function public.mfc_start_game(uuid,integer,integer,integer,text) to authenticated;
grant execute on function public.mfc_submit_combos(uuid,jsonb) to authenticated;
grant execute on function public.mfc_vote(uuid,uuid) to authenticated;
grant execute on function public.mfc_get_game_state(uuid) to authenticated;
grant execute on function public.mfc_next_round(uuid) to authenticated;
