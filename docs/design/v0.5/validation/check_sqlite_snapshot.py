"""A deterministic two-connection reference observation, not a Bun/HTTP integration test."""
from pathlib import Path
import sqlite3, tempfile
ROOT=Path(__file__).resolve().parents[1]
def observe():
    observations=[]
    with tempfile.TemporaryDirectory(prefix='bc-v05-snapshot-') as directory:
        path=Path(directory)/'snapshot.sqlite'
        a=sqlite3.connect(path,isolation_level=None,timeout=0)
        b=sqlite3.connect(path,isolation_level=None,timeout=0)
        try:
            a.executescript((ROOT/'reference/sqlite-schema.sql').read_text())
            for c in (a,b):
                c.execute('PRAGMA foreign_keys=ON')
                assert c.execute('PRAGMA journal_mode=WAL').fetchone()[0]=='wal'
                c.execute('PRAGMA synchronous=FULL')
                c.execute('PRAGMA busy_timeout=0')
            a.execute("INSERT INTO memberships VALUES('t','u',1)")
            a.execute("INSERT INTO products VALUES('t','p',7,1,12000,'KRW')")
            a.execute("INSERT INTO form_intents VALUES('i','t','u','orders.createDraft','p',7,?,100,1000,NULL)",('a'*64,))
            query="""SELECT i.consumed_at,r.draft_id FROM form_intents i
                     LEFT JOIN action_results r ON r.intent_id=i.id WHERE i.id='i'"""
            a.execute('BEGIN')
            assert a.execute(query).fetchone()==(None,None)
            b.execute('BEGIN IMMEDIATE')
            # Reader has a coherent snapshot even while another connection owns writer reservation.
            assert a.execute(query).fetchone()==(None,None)
            sql=(ROOT/'reference/insert-draft-cas.sql').read_text()
            params=dict(draftId='draft_a',intentId='i',tenantId='t',subjectId='u',productId='p',quantity=2,expectedRevision=7,behaviorHash='a'*64,now=200)
            assert b.execute(sql,params).rowcount==1
            b.execute("UPDATE form_intents SET consumed_at=200 WHERE id='i'")
            b.execute("INSERT INTO action_results VALUES('i',?,?,'draft_a',200,2000)",('a'*64,'b'*64))
            b.execute('COMMIT')
            assert a.execute(query).fetchone()==(None,None)
            observations.append('reader retains OPEN snapshot across other-connection completion')
            a.execute('COMMIT');a.execute('BEGIN')
            assert a.execute(query).fetchone()==(200,'draft_a')
            a.execute('COMMIT')
            observations.append('new read transaction observes consumed intent and matching result together')
            b.execute('BEGIN IMMEDIATE');a.execute('BEGIN')
            assert a.execute(query).fetchone()==(200,'draft_a')
            a.execute('COMMIT');b.execute('ROLLBACK')
            observations.append('completed result read does not require a writer reservation')
            return {'status':'VERIFIED_REFERENCE_ONLY','sqliteVersion':sqlite3.sqlite_version,'connections':2,'journalMode':'wal','schedule':'deterministic interleaving in one Python process','observations':observations,'notRun':['Bun adapter','simultaneous HTTP requests','throughput','crash or power loss','current-deployment SQLite qualification']}
        finally:
            for c in (a,b):
                if c.in_transaction:c.rollback()
                c.close()
if __name__=='__main__':
    import json
    print(json.dumps(observe(),ensure_ascii=False,indent=2))
