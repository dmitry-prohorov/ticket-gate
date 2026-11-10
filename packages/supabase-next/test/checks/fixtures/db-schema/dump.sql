--
-- PostgreSQL database dump
--

\restrict Ng4fJi4ghuE6ZbVGdjRWWfvLY7bvkzwdZn445ZDrkpoXmKb6R4FaFRBVPJmbsFm

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


--
-- Name: private; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA private;


ALTER SCHEMA private OWNER TO postgres;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'standard public schema';

--
-- Name: member_role; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.member_role AS ENUM (
    'owner',
    'adult',
    'child'
);


ALTER TYPE public.member_role OWNER TO postgres;

--
-- Name: TYPE member_role; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TYPE public.member_role IS 'Role of a family member.';  


--
-- Name: has_family_role(uuid); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.has_family_role(p_user_family uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select private.has_family_role(p_user_family, null);
$$;


ALTER FUNCTION private.has_family_role(p_user_family uuid) OWNER TO postgres;


--
-- Name: has_family_role(uuid, public.member_role[]); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.has_family_role(p_family_id uuid, p_roles public.member_role[]) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1 from public.family_members m
    where m.family_id = p_family_id
      and m.user_id = (select auth.uid())
      and (p_roles is null or m.role = any (p_roles))
  );
$$;


ALTER FUNCTION private.has_family_role(p_family_id uuid, p_roles public.member_role[]) OWNER TO postgres;

--
-- Name: FUNCTION has_family_role(p_user_family uuid); Type: COMMENT; Schema: private; Owner: postgres
--

COMMENT ON FUNCTION private.has_family_role(p_user_family uuid) IS 'Any role.';	


SET default_tablespace = '';

SET default_table_access_method = heap;


--
-- Name: notification_prefs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.notification_prefs (
    member_id uuid NOT NULL,
    push_enabled boolean DEFAULT true NOT NULL,
    quiet_hours_start time without time zone,
    quiet_hours_end time without time zone,
    default_offsets integer[] DEFAULT '{15}'::integer[] NOT NULL,
    notify_parents boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_prefs_quiet_pair CHECK (((quiet_hours_start IS NULL) = (quiet_hours_end IS NULL)))
);


ALTER TABLE public.notification_prefs OWNER TO postgres;

--
-- Name: TABLE notification_prefs; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.notification_prefs IS 'Per-member notification preferences.';


--
-- Name: COLUMN notification_prefs.notify_parents; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.notification_prefs.notify_parents IS 'Also notify parents.';


--
-- Name: notification_prefs_seq_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.notification_prefs_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.notification_prefs_seq_seq OWNER TO postgres;


--
-- Name: SEQUENCE notification_prefs_seq_seq; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON SEQUENCE public.notification_prefs_seq_seq IS 'Synthetic.';


--
-- Name: notification_prefs_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.notification_prefs_seq_seq OWNED BY public.notification_prefs.member_id;


--
-- Name: notification_prefs seq; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notification_prefs ALTER COLUMN seq SET DEFAULT nextval('public.notification_prefs_seq_seq'::regclass);


--
-- Name: notification_prefs notification_prefs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notification_prefs
    ADD CONSTRAINT notification_prefs_pkey PRIMARY KEY (member_id);

--
-- Name: CONSTRAINT notification_prefs_pkey ON notification_prefs; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON CONSTRAINT notification_prefs_pkey ON public.notification_prefs IS 'Synthetic.';


--
-- Name: notification_prefs_updated_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX notification_prefs_updated_idx ON public.notification_prefs USING btree (updated_at);


--
-- Name: notification_prefs notification_prefs_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER notification_prefs_updated_at BEFORE UPDATE ON public.notification_prefs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: TRIGGER notification_prefs_updated_at ON notification_prefs; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TRIGGER notification_prefs_updated_at ON public.notification_prefs IS 'Synthetic.';


--
-- Name: notification_prefs notification_prefs_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.notification_prefs
    ADD CONSTRAINT notification_prefs_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.family_members(id) ON DELETE CASCADE;

--
-- Name: notification_prefs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.notification_prefs ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_prefs notification_prefs_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY notification_prefs_all ON public.notification_prefs TO authenticated USING ((member_id IN ( SELECT private.my_member_ids() AS my_member_ids))) WITH CHECK ((member_id IN ( SELECT private.my_member_ids() AS my_member_ids)));

--
-- Name: POLICY notification_prefs_all ON notification_prefs; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON POLICY notification_prefs_all ON public.notification_prefs IS 'Synthetic.';


--
-- Name: SCHEMA private; Type: ACL; Schema: -; Owner: postgres
--

GRANT USAGE ON SCHEMA private TO authenticated;
GRANT USAGE ON SCHEMA private TO service_role;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;

--
-- Name: FUNCTION has_family_role(p_family_id uuid, p_roles public.member_role[]); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.has_family_role(p_family_id uuid, p_roles public.member_role[]) FROM PUBLIC;

--
-- Name: FUNCTION has_family_role(p_user_family uuid); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.has_family_role(p_user_family uuid) FROM PUBLIC;


--
-- Name: TYPE member_role; Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON TYPE public.member_role FROM PUBLIC;


--
-- Name: TABLE notification_prefs; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notification_prefs TO authenticated;
GRANT ALL ON TABLE public.notification_prefs TO service_role;

--
-- Name: COLUMN notification_prefs.push_enabled; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(push_enabled) ON TABLE public.notification_prefs TO anon;


--
-- Name: SEQUENCE notification_prefs_seq_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT USAGE ON SEQUENCE public.notification_prefs_seq_seq TO authenticated;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--


